import type { Key } from "ink";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from "react";
import { TextareaUtils } from "../textarea/TextareaUtils.ts";
import type { TextSelection } from "../textarea/types.ts";
import { useClipboard } from "./clipboard.tsx";
import { SelectionStore } from "./selectionStore.ts";

/** How long after a press a second one on the same spot still counts as a double click. */
const DOUBLE_CLICK_DELAY = 400;

/** Keys a selection answers: Shift and an arrow, Ctrl+A and Ctrl+C. */
export const isSelectionKey = (input: string, key: Key) =>
  (key.shift && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) ||
  (key.ctrl && (input === "a" || input === "c"));

/**
 * A selection out of a run of text, by offsets into `value`: pressed and
 * dragged out with the mouse — a word at a time from a double click —
 * stretched with Shift and the arrows, Alt taking a whole word at a time, all
 * of it taken with Ctrl+A, and copied to the clipboard with Ctrl+C.
 *
 * Whatever draws the text places the pointer and steps up and down it; this
 * only keeps the selection — `Selectable` and `Textarea` are both built on it. Only one is ever held at a time, as a terminal
 * has only the one: making one here clears whichever was held before, and
 * while it is held, with `isActive`, Ctrl+C is this one's to copy with rather
 * than the app's to quit on.
 */
export const useSelection = ({
  value,
  selection: controlled,
  onSelectionChange,
  isActive,
  expand,
  vertical,
  onFocus
}: {
  /** The text, or a way to read it for what is only known once drawn. */
  value: string | (() => string);
  /** The selection, held here when it is left uncontrolled. */
  selection?: TextSelection | null;
  onSelectionChange?: (selection: TextSelection | null) => void;
  /** Whether the keys go to the selection while it is held. */
  isActive: boolean;
  /** Stretches a selection over any run it reaches into that only goes whole. */
  expand?: (selection: TextSelection) => TextSelection;
  /** The offset a step onto the row above or below an offset lands on. */
  vertical: (offset: number, direction: 1 | -1) => number;
  /** Follows where the selection was pressed or stretched to, as a cursor does. */
  onFocus?: (offset: number) => void;
}) => {
  const id = useId();
  const text = () => (typeof value === "string" ? value : value());

  const [uncontrolled, setUncontrolled] = useState<TextSelection | null>(null);
  const selection = controlled !== undefined ? controlled : uncontrolled;

  const setSelection = (next: TextSelection | null) => {
    setUncontrolled(next);
    onSelectionChange?.(next);
  };

  // Where the selection was started, which it is stretched away from.
  const anchorRef = useRef(0);

  // Where and when the last press landed, which a second one on the same spot
  // turns into a double click.
  const pressRef = useRef({ at: 0, offset: -1 });

  // The word a double click took, which the drag after it goes on taking whole
  // words away from. Null while the selection is taken a character at a time.
  const wordRef = useRef<[start: number, end: number] | null>(null);

  // A held selection is cleared by whichever takes over from it.
  const clear = useEffectEvent(() => setSelection(null));
  const isHolding = isActive && !!selection;
  useEffect(() => {
    if (!isHolding) return;
    SelectionStore.hold({ id, clear: () => clear() });
    return () => SelectionStore.release(id);
  }, [id, isHolding]);

  /**
   * The selection from its anchor out to where it was taken, by the word once
   * a double click has started it on one.
   */
  const stretched = (focused: number): TextSelection => {
    const word = wordRef.current;
    const selected: TextSelection = word
      ? TextareaUtils.words(text(), word, focused)
      : [anchorRef.current, focused];

    // Nothing is selected yet, and a cursor reaches into no run of its own.
    if (selected[0] === selected[1]) return selected;

    return expand?.(selected) ?? selected;
  };

  /** Stretches the selection out to an offset, followed by the focus. */
  const reach = (focused: number) => {
    const selected = stretched(focused);
    onFocus?.(selected[1]);
    setSelection(selected[0] === selected[1] ? null : selected);
  };

  const clipboard = useClipboard();
  const copy = () => {
    if (selection) void clipboard(TextareaUtils.selected(text(), selection));
  };

  /**
   * A press on an offset, at a time: it clears the selection — this one and
   * any other — and is where the drag after it stretches a new one from. A
   * second press where the last one landed takes the word under it, and the
   * drag that follows goes on taking whole words rather than characters.
   */
  const press = (pressed: number, time: number) => {
    SelectionStore.clear(id);

    const isDouble =
      pressed === pressRef.current.offset && time - pressRef.current.at < DOUBLE_CLICK_DELAY;

    pressRef.current = { at: time, offset: pressed };
    wordRef.current = isDouble ? TextareaUtils.word(text(), pressed) : null;
    anchorRef.current = pressed;

    if (isDouble) {
      reach(pressed);
      return;
    }

    onFocus?.(pressed);
    setSelection(null);
  };

  /** Leaves the last press out of the next one's double click. */
  const forget = () => {
    pressRef.current = { at: 0, offset: -1 };
  };

  /**
   * Whether a key belongs to a selection held somewhere else — one in the
   * read-only `Selectable`, for a text area — rather than here. Any other key clears that
   * selection, as it goes on to act here instead.
   */
  const isHeldElsewhere = (input: string, key: Key) => {
    const holder = SelectionStore.holder();
    if (!holder || holder.id === id) return false;
    if (isSelectionKey(input, key)) return true;
    SelectionStore.clear(id);
    return false;
  };

  /**
   * Answers the keys a selection does, returning whether it took the key.
   * With nothing selected, Shift and an arrow start from `origin` — a
   * cursor's — or else are left alone.
   */
  const handleKey = (input: string, key: Key, origin?: number) => {
    const isArrow = key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;

    // Shift stretches the selection; Alt takes a whole word at a time. A
    // selection already taken carries on from the end it was anchored at.
    // The stdin adapter normalizes Terminal.app's escaped arrows to Shift.
    if (isArrow && key.shift) {
      const from = selection?.[1] ?? origin;
      if (from === undefined) return false;

      anchorRef.current = selection ? selection[0] : from;
      wordRef.current = null;
      const value = text();

      reach(
        key.upArrow || key.downArrow
          ? vertical(from, key.upArrow ? -1 : 1)
          : key.meta
            ? key.leftArrow
              ? TextareaUtils.wordStart(value, from)
              : TextareaUtils.wordEnd(value, from)
            : key.leftArrow
              ? TextareaUtils.previous(value, from)
              : TextareaUtils.next(value, from)
      );
      return true;
    }

    // Select all.
    if (key.ctrl && input === "a") {
      const { length } = text();
      if (!length) return true;

      anchorRef.current = 0;
      wordRef.current = null;

      reach(length);
      return true;
    }

    // Copy, which leaves the selection where it is. With nothing selected
    // Ctrl+C is the app's to quit on.
    if (key.ctrl && input === "c") {
      copy();
      return true;
    }

    return false;
  };

  return {
    selection,
    setSelection,
    /** Stretches the selection out to an offset the pointer was dragged to. */
    drag: reach,
    /** Where the selection being taken was started. */
    anchor: () => anchorRef.current,
    press,
    forget,
    isHeldElsewhere,
    handleKey,
    copy,
    /** The selected text, empty while nothing is selected. */
    selected: () => TextareaUtils.selected(text(), selection)
  };
};

/**
 * Whether any selection is held, for an app deciding what Ctrl+C does: copy while there is one,
 * quit while there is not.
 */
export const useHasSelection = () =>
  useSyncExternalStore(
    SelectionStore.subscribe,
    () => SelectionStore.holder() !== null,
    () => false
  );
