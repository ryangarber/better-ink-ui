import {
  type DOMElement,
  Text as InkText,
  type Key,
  useBoxMetrics,
  useInput,
  usePaste,
  useStdout,
  useWindowSize
} from "ink";
import { type ReactNode, type Ref, useMemo, useRef, useState } from "react";
import { contains, getVisibleBounds } from "../input/geometry.ts";
import { useMouseInput } from "../input/useMouseInput.ts";
import { Box } from "../layout/Box.tsx";
import { useWheel } from "../scroll/useWheel.ts";
import { useSelection } from "../selection/useSelection.ts";
import { useMergedRef } from "../shared/useMergedRef.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import {
  TAB_WIDTH,
  TEXT_LABEL,
  TEXT_PAINT,
  type TextareaPaint,
  type TextareaRowCache,
  TextareaUtils
} from "./TextareaUtils.ts";
import type {
  TextareaAtom,
  TextareaCursor,
  TextareaEdit,
  TextareaLabels,
  TextareaRow,
  TextareaStyle,
  TextareaStyles,
  TextSelection
} from "./types.ts";
import { useCursorBlink } from "./useCursorBlink.ts";
import { useUndo } from "./useUndo.ts";

/** Text drawn with its colors swapped, which is how the cursor is drawn. */
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;

const NO_ATOMS: readonly TextareaAtom[] = [];

/** A style as Ink's `<Text>` props, its colors resolved through the theme. */
const toTextProps = (
  style: TextareaStyle | undefined,
  resolve: (color: TextareaStyle["color"]) => string | undefined
) =>
  style && {
    color: resolve(style.color),
    backgroundColor: resolve(style.backgroundColor),
    dimColor: style.dimColor,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
    inverse: style.inverse
  };
const NO_LABELS: TextareaLabels = [];

export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Whether keys go to the text area, and the cursor is drawn. */
  focus: boolean;
  /** Drawn dimmed while the value is empty. */
  placeholder?: string;
  /** Rules that paint the value, styled by `styles`. */
  labels?: TextareaLabels;
  /** Styles by label, with `text` for the text no label claimed. */
  styles?: TextareaStyles;
  /**
   * Runs of the value handled whole — stepped over, selected and deleted as one — such as mentions
   * or chips standing in the text. Those with a label are painted under it ahead of `labels`.
   * Keep the array's identity while the value is the same.
   */
  atoms?: readonly TextareaAtom[];
  /** The cursor, held here when it is left uncontrolled. */
  cursor?: TextareaCursor;
  onCursorChange?: (cursor: TextareaCursor) => void;
  /** The selection, held here when it is left uncontrolled. */
  selection?: TextSelection | null;
  onSelectionChange?: (selection: TextSelection | null) => void;
  /** Takes a plain Enter over, in place of the newline it writes. Shift+Enter always writes one. */
  onEnter?: () => void;
  /** Ctrl, Alt or Super with Enter. */
  onSubmit?: (value: string) => void;
  /** Takes a bracketed paste over, in place of inserting it at the cursor. */
  onPaste?: (text: string) => void;
  /**
   * Sees every key before the text area does, and takes it by returning `true` — or by returning
   * the edit it makes in its place, which is undone and redone like any other.
   */
  onKey?: (input: string, key: Key) => boolean | TextareaEdit | null | undefined | void;
  /**
   * Sees the offset a press landed on — inside an atom too — before the cursor moves there, and
   * takes the press, and the drag after it, by returning `true`.
   */
  onClick?: (offset: number) => boolean | undefined | void;
  /** Rows drawn before the rest scroll. @default half the terminal */
  maxRows?: number;
  /** Whether the cursor blinks while it is not being moved. @default true */
  cursorBlink?: boolean;
  /** Rows a turn of the wheel scrolls. @default 1 */
  wheelStep?: number;
  ref?: Ref<DOMElement>;
}

/**
 * A multiline text field: wrapped to its width, scrolled past `maxRows`, painted by pattern, with
 * atoms that go whole. It is selected from like any other text (see `useSelection`), with the
 * cursor following the selection; cut from with Ctrl+X; pasted into; and undone and redone a word
 * at a time with Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z). Alt moves and deletes a word at a time.
 */
export function Textarea({
  value,
  onChange,
  focus,
  placeholder,
  labels = NO_LABELS,
  styles,
  atoms = NO_ATOMS,
  cursor: controlledCursor,
  onCursorChange,
  selection: controlledSelection,
  onSelectionChange,
  onEnter,
  onSubmit,
  onPaste,
  onKey,
  onClick,
  maxRows,
  cursorBlink = true,
  wheelStep = 1,
  ref
}: TextareaProps) {
  const theme = useTheme();
  const { rows: terminalRows } = useWindowSize();
  const { stdout } = useStdout();

  const [uncontrolledCursor, setUncontrolledCursor] = useState<TextareaCursor>([0, 0]);
  const cursor = controlledCursor ?? uncontrolledCursor;
  const offset = TextareaUtils.offset(value, cursor);

  const blink = useCursorBlink(focus && cursorBlink);
  const history = useUndo();

  /** Moves the cursor to an offset into the value, or into the one given. */
  const moveTo = (to: number, against = value) => {
    const next = TextareaUtils.cursor(against, to);
    setUncontrolledCursor(next);
    onCursorChange?.(next);
    blink.hold();
  };

  // Whether the last press was taken by `onClick`, along with its drag.
  const isTakenRef = useRef(false);

  const textRef = useRef<DOMElement | null>(null);
  const { width } = useBoxMetrics(textRef);

  // Lines wrapped at this width, which an edit only re-wraps where it touched.
  const cacheRef = useRef<{ width: number; rows: TextareaRowCache }>({ width, rows: new Map() });
  if (cacheRef.current.width !== width) cacheRef.current = { width, rows: new Map() };
  const rowCache = cacheRef.current.rows;

  const rows = useMemo(
    () => TextareaUtils.rows({ value, width, cursor: focus ? cursor : null, cache: rowCache }),
    [value, width, cursor, focus, rowCache]
  );
  const cursorRow = focus ? TextareaUtils.row({ rows, cursor }) : -1;

  // Past `maxRows` the rows scroll. Whenever they change under it — an edit, a step of the cursor,
  // a resize — the viewport moves only as far as it takes to bring the cursor back into view, and
  // in between stays wherever the wheel turned it.
  const height = Math.max(1, maxRows ?? Math.floor(terminalRows / 2));
  const maxTop = Math.max(0, rows.length - height);
  const [view, setView] = useState({ top: 0, rows });

  let top = Math.min(view.top, maxTop);
  if (view.rows !== rows) {
    top = TextareaUtils.scroll({ offset: view.top, index: cursorRow, count: rows.length, height });
    setView({ top, rows });
  }

  // The wheel turns over whatever the pointer is on, focused or not, and inside a scroll view it is
  // offered the turn first, passing it on at either end.
  useWheel(
    (event) => {
      const node = textRef.current;
      if (!node) return "passed";
      const bounds = getVisibleBounds(node, (stdout as NodeJS.WriteStream).rows ?? terminalRows);
      if (!bounds || !contains(bounds, event)) return "passed";
      const current = Math.min(view.top, maxTop);
      const next = Math.min(Math.max(0, current + event.deltaY * wheelStep), maxTop);
      if (next === current) return "passed";
      setView((view) => ({ ...view, top: next }));
      return "moved";
    },
    { isActive: rows.length > height }
  );

  /** Where a point was pressed or dragged to. */
  const pointedAt = (event: { x: number; y: number }) =>
    TextareaUtils.offset(value, TextareaUtils.position({ value, rows, point: event, offset: top }));

  /** Where the cursor lands moving to an offset, kept out of every atom. */
  const snapped = (to: number, from = offset) => TextareaUtils.snap(atoms, to, from);

  const { selection, setSelection, ...selecting } = useSelection({
    value,
    selection: controlledSelection,
    onSelectionChange,
    isActive: focus,
    expand: atoms.length ? (selected) => TextareaUtils.expand(atoms, selected) : undefined,
    vertical: (from, direction) =>
      TextareaUtils.vertical({ value, rows, cursor: TextareaUtils.cursor(value, from), direction }),
    onFocus: moveTo
  });

  /**
   * Hands a new value on with the cursor at an offset into it. The cursor goes first, so a parent
   * rewriting the change on its way in has the last word on where the cursor ends up.
   */
  const change = (next: string, to: number) => {
    moveTo(to, next);
    if (selection) setSelection(null);
    onChange(next);
  };

  /** Writes text at the cursor, over whatever is selected. */
  const write = (text: string, isWhole = false) => {
    const [start, end] = selection ? TextareaUtils.range(selection) : [offset, offset];
    history.record("insert", { value, offset }, isWhole);
    change(value.slice(0, start) + text + value.slice(end), start + text.length);
  };

  /** Makes an edit whole, leaving its selection behind it. */
  const edit = ({ value: next, selection: selected }: TextareaEdit) => {
    const [anchor, focused] = selected;
    if (next !== value) history.record("insert", { value, offset }, true);
    moveTo(focused, next);
    setSelection(anchor === focused ? null : selected);
    if (next !== value) onChange(next);
  };

  /** Takes a range out of the value. */
  const remove = ([start, end]: [start: number, end: number], isWhole = false) => {
    if (start === end) return;
    history.record("delete", { value, offset }, isWhole);
    change(value.slice(0, start) + value.slice(end), start);
  };

  const { mouseRef } = useMouseInput({
    onClick: ({ event }) => {
      isTakenRef.current = !!onClick?.(pointedAt(event));
      if (isTakenRef.current) {
        selecting.forget();
        return;
      }
      const at = pointedAt(event);
      selecting.press(snapped(at, at), event.time);
    },
    onDrag: ({ event }) => {
      if (isTakenRef.current) return;
      selecting.drag(snapped(pointedAt(event), selecting.anchor()));
    },
    isActive: focus
  });

  // Terminals send newlines as carriage returns, which the value holds as line feeds.
  usePaste(
    (text) => {
      const pasted = text.replace(/\r\n?/g, "\n");
      if (!pasted) return;
      if (onPaste) onPaste(pasted);
      else write(pasted, true);
    },
    { isActive: focus }
  );

  useInput(
    (typed, pressed) => {
      // Option and a delete, as terminals send them with no Alt to put on them: the Emacs Ctrl+W
      // for Option+Backspace, and Alt+D for Option+Delete. Read as the Alt and delete they stand
      // for, by the text area and `onKey` alike.
      const isWordBackspace = pressed.ctrl && typed === "w";
      const isWordDelete = pressed.meta && typed === "d";
      const input = isWordBackspace || isWordDelete ? "" : typed;
      const key: Key =
        isWordBackspace || isWordDelete
          ? {
              ...pressed,
              ctrl: false,
              meta: true,
              backspace: isWordBackspace,
              delete: isWordDelete
            }
          : pressed;

      // A selection held elsewhere takes the keys a selection answers, and is let go by any other.
      if (selecting.isHeldElsewhere(input, key)) return;

      const taken = onKey?.(input, key);
      if (taken === true) return;
      if (taken) {
        edit(taken);
        return;
      }

      const isArrow = key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;
      const isSubmit = key.return && (key.ctrl || key.meta || key.super);
      const isShiftEnter = key.return && key.shift;

      if (isSubmit) {
        onSubmit?.(value);
        return;
      }
      if (key.return) {
        if (onEnter && !isShiftEnter) onEnter();
        else write("\n");
        return;
      }

      // Shift and an arrow stretch the selection from the cursor; Ctrl+A takes it all; Ctrl+C copies.
      if (selecting.handleKey(input, key, offset)) return;

      // An arrow collapses the selection to the side it points at.
      if (isArrow && selection) {
        const [start, end] = TextareaUtils.range(selection);
        moveTo(key.leftArrow || key.upArrow ? start : end);
        setSelection(null);
        return;
      }

      // Word motion, which terminals send as Alt and an arrow, or the Emacs Alt+B and Alt+F —
      // which is what macOS Terminal sends for Option and an arrow.
      const isWordBack = key.meta && (key.leftArrow || input === "b");
      const isWordForward = key.meta && (key.rightArrow || input === "f");
      if (isWordBack || isWordForward) {
        if (selection) setSelection(null);
        moveTo(
          snapped(
            isWordBack
              ? TextareaUtils.wordStart(value, offset)
              : TextareaUtils.wordEnd(value, offset)
          )
        );
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        moveTo(
          snapped(
            key.leftArrow
              ? TextareaUtils.previous(value, offset)
              : TextareaUtils.next(value, offset)
          )
        );
        return;
      }

      // Home and End go to either end of the line, and under Ctrl to either end of the value.
      if (key.home || key.end) {
        if (selection) setSelection(null);
        const [line] = cursor;
        moveTo(
          key.ctrl
            ? key.home
              ? 0
              : value.length
            : TextareaUtils.offset(value, [line, key.home ? 0 : Number.POSITIVE_INFINITY])
        );
        return;
      }

      // There is no row above the first, so Up there goes to the start, and Down on the last to the end.
      if (key.upArrow || key.downArrow) {
        moveTo(
          snapped(TextareaUtils.vertical({ value, rows, cursor, direction: key.upArrow ? -1 : 1 }))
        );
        return;
      }

      // A delete takes the selection out whole, or else a character — a word under Alt — and any
      // atom against or around the cursor whole.
      if (key.backspace || key.delete) {
        if (selection) {
          remove(TextareaUtils.range(selection));
          return;
        }
        remove(
          TextareaUtils.deletion(value, atoms, offset, key.backspace ? -1 : 1, key.meta),
          key.meta
        );
        return;
      }

      // Cut: the selection out, and onto the clipboard.
      if (key.ctrl && input === "x") {
        if (!selection) return;
        selecting.copy();
        remove(TextareaUtils.range(selection), true);
        return;
      }

      // Undo, and redo under Ctrl+Y or Ctrl+Shift+Z — which a terminal only tells from Ctrl+Z
      // over the kitty keyboard protocol.
      const letter = input.toLowerCase();
      if (key.ctrl && (letter === "z" || letter === "y")) {
        const isUndo = letter === "z" && !key.shift;
        const entry = (isUndo ? history.undo : history.redo)({ value, offset });
        if (entry) change(entry.value, entry.offset);
        return;
      }

      // Any other key leaves the selection behind rather than acting on it.
      if (key.ctrl || key.escape || key.tab || !input) {
        if (selection) setSelection(null);
        return;
      }

      write(input);
    },
    { isActive: focus }
  );

  const textProps = (style: TextareaStyle | undefined) => toTextProps(style, theme.resolve);

  const selectionPaint = useMemo<TextareaPaint>(
    () => ({
      label: TEXT_LABEL,
      style: {
        color: theme.colors.selection,
        backgroundColor: theme.colors.selectionBackground
      }
    }),
    [theme]
  );

  const baseStyle = useMemo(
    () => toTextProps({ color: theme.colors.text, ...styles?.text }, theme.resolve),
    [theme, styles]
  );

  const painted = useMemo(() => TextareaUtils.paint(value, labels, atoms), [value, labels, atoms]);
  const placeholderPainted = useMemo(
    () => TextareaUtils.paint(placeholder ?? "", labels),
    [placeholder, labels]
  );

  const [selectedStart, selectedEnd] = selection ? TextareaUtils.range(selection) : [0, 0];

  /**
   * Draws a run of text in the runs of its labels, with the cursor at an offset into it, or -1
   * where it is not drawn.
   *
   * @param start Where the text starts in the value its labels are painted over.
   * @param isDimmed Whether it is the placeholder, which is drawn dimmed, all but the cursor.
   */
  const draw = ({
    text,
    start,
    paints,
    cursorAt,
    isDimmed = false
  }: {
    text: string;
    start: number;
    paints: TextareaPaint[];
    cursorAt: number;
    isDimmed?: boolean;
  }) => {
    const nodes: ReactNode[] = [];
    let run = "";
    let runPaint: TextareaPaint | null = null;
    let runDim = false;

    const flush = () => {
      if (!run || !runPaint) return;
      const style = textProps({
        ...TextareaUtils.style(styles, runPaint.label),
        ...runPaint.style,
        ...(runDim && theme.colors.placeholder ? { color: theme.colors.placeholder } : {})
      });
      nodes.push(
        <InkText key={nodes.length} {...style} dimColor={runDim || style?.dimColor}>
          {run}
        </InkText>
      );
      run = "";
    };

    const append = (cell: string, paint: TextareaPaint, dim: boolean) => {
      if (paint !== runPaint || dim !== runDim) flush();
      runPaint = paint;
      runDim = dim;
      run += cell;
    };

    for (const { segment, index } of TextareaUtils.graphemes(text)) {
      const at = start + index;
      const display = segment === "\t" ? " ".repeat(TAB_WIDTH) : segment;
      const isCursor = index === cursorAt && blink.isVisible;
      const paint =
        !isDimmed && at >= selectedStart && at < selectedEnd
          ? selectionPaint
          : (paints[at] ?? TEXT_PAINT);
      // A tab is drawn as spaces, the cursor on the first of them.
      const cell = !isCursor
        ? display
        : segment === "\t"
          ? inverse(" ") + display.slice(1)
          : inverse(display);
      append(cell, paint, isDimmed && !isCursor);
    }

    // The cursor past the end of the text, on a cell of its own.
    if (cursorAt === text.length) append(blink.isVisible ? inverse(" ") : " ", TEXT_PAINT, false);

    flush();
    if (nodes.length === 0) nodes.push(<InkText key={0}> </InkText>);
    return nodes;
  };

  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1))
      starts.push(index + 1);
    return starts;
  }, [value]);

  const drawRow = (row: TextareaRow, index: number) => {
    // The placeholder stands in the first row while there is nothing else.
    if (!value && placeholder) {
      const [line = ""] = placeholder.split("\n");
      return draw({
        text: line,
        start: 0,
        paints: placeholderPainted,
        cursorAt: focus ? 0 : -1,
        isDimmed: true
      });
    }
    const start = (lineStarts[row.line] ?? 0) + row.column;
    return draw({
      text: row.text,
      start,
      paints: painted,
      cursorAt: index === cursorRow ? offset - start : -1
    });
  };

  const mergedRef = useMergedRef(textRef, mouseRef, ref);

  return (
    <Box ref={mergedRef} flexGrow={1} flexDirection="column">
      {rows.slice(top, top + height).map((row, index) => (
        <InkText key={`${row.line}:${row.column}`} {...baseStyle} wrap="wrap">
          {drawRow(row, top + index)}
        </InkText>
      ))}
    </Box>
  );
}
