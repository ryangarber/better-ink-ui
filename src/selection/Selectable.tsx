import { type DOMElement, type Key, measureElement, useInput, useStdout } from "ink";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from "react";
import { contains, getBounds, isCovered } from "../input/geometry.ts";
import type { Point } from "../input/mouse.ts";
import { useMouse } from "../input/useMouse.ts";
import { useMouseInput, useMouseLayer } from "../input/useMouseInput.ts";
import { Box, type BoxProps } from "../layout/Box.tsx";
import { Text } from "../layout/Text.tsx";
import { useMergedRef } from "../shared/useMergedRef.ts";
import type { TextSelection } from "../textarea/types.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { type TextLayout, TextLayoutUtils, type TextRow } from "./TextLayoutUtils.ts";
import { useSelection } from "./useSelection.ts";

/**
 * How often a held selection looks again at what is drawn, as Ink has nothing like a mutation
 * observer: content streaming in under it, a resize.
 */
const POLL_INTERVAL = 100;

export interface SelectionMenuProps {
  /** The selected text, trimmed. */
  text: string;
  /** Lets the selection go. */
  dismiss: () => void;
}

/**
 * What is drawn over a selection while it is held — buttons to quote it, search for it — given
 * the selected text. Mouse presses on it do not let the selection go.
 */
export type SelectionMenu = (props: SelectionMenuProps) => ReactNode;

/** The menu a selection made anywhere inside offers, unless a `Selectable` sets its own. */
export const SelectionMenuContext = createContext<SelectionMenu | null>(null);

/** Whether a selectable is drawn inside another, which selects for it. */
const SelectableContext = createContext(false);

/** A block of the text drawn, from `start` in the text as a whole. */
interface SelectableBlock {
  node: DOMElement;
  text: string;
  start: number;
  layout: TextLayout | null | undefined;
}

/** What is drawn, read as one run of text: its blocks, a line apiece. */
interface SelectableText {
  blocks: SelectableBlock[];
  value: string;
}

const EMPTY: SelectableText = { blocks: [], value: "" };

const layoutOf = (block: SelectableBlock) => {
  if (block.layout === undefined) block.layout = TextLayoutUtils.layout(block.node);
  return block.layout;
};

/** The last line of a block anything is drawn on. */
const lastLine = (layout: TextLayout) =>
  layout.cells.reduce((last, cell) => Math.max(last, cell?.line ?? 0), 0);

const isSame = (a: TextRow[], b: TextRow[]) =>
  a.length === b.length &&
  a.every((row, i) => row.x === b[i]?.x && row.y === b[i]?.y && row.text === b[i]?.text);

export interface SelectableProps extends BoxProps {
  /** Drawn over the selection while it is held. Defaults to the nearest `SelectionMenuContext`. */
  menu?: SelectionMenu | null;
  /** Called with the selected text as the selection changes, and with "" once it is let go. */
  onSelectionChange?: (text: string) => void;
}

/**
 * Text that can be selected the way a terminal selects it, but scoped to what is drawn here and
 * aware of the layout: wrapped lines, scrolled views, tables. Whatever is drawn inside is read back
 * off the screen, a block of text to a line, and selected out of as a text area is (see
 * `useSelection`): dragged over with the mouse — a word at a time from a double click — stretched
 * with Shift and the arrows once there is a selection, taken whole with Ctrl+A and copied with
 * Ctrl+C. Escape, or a press anywhere else, lets it go.
 *
 * One drawn inside another leaves its text to the outer one, so a selection runs on from a
 * paragraph into the block of code after it. Wrap what is drawn but is not text — line numbers,
 * buttons — in `<Unselectable>`.
 */
export function Selectable({
  children,
  ref: ownRef,
  menu: ownMenu,
  onSelectionChange,
  ...props
}: SelectableProps) {
  const isNested = useContext(SelectableContext);
  const contextMenu = useContext(SelectionMenuContext);
  const menu = ownMenu === undefined ? contextMenu : ownMenu;
  const { stdout } = useStdout();
  const theme = useTheme();

  const ref = useRef<DOMElement>(null);
  const highlightsRef = useRef<DOMElement>(null);
  const menuRef = useRef<DOMElement>(null);
  const terminalRows = () => (stdout as NodeJS.WriteStream).rows ?? 24;

  // Read off the screen as a gesture starts, and kept through it.
  const textRef = useRef<SelectableText>(EMPTY);

  const read = () => {
    const root = ref.current;
    if (!root) return EMPTY;
    const blocks: SelectableBlock[] = [];
    let value = "";
    for (const node of TextLayoutUtils.blocks(root, [highlightsRef.current, menuRef.current])) {
      const text = TextLayoutUtils.text(node);
      if (!text) continue;
      if (blocks.length) value += "\n";
      blocks.push({ node, text, start: value.length, layout: undefined });
      value += text;
    }
    textRef.current = { blocks, value };
    return textRef.current;
  };

  /**
   * The offset a point lands on, in Ink's coordinates. Of the blocks drawn on its row, it is the
   * one furthest along that starts at or before it — the cell of a table it is in — and between
   * rows, the end of the block above.
   */
  const offsetAt = (point: Point) => {
    let on: { block: SelectableBlock; layout: TextLayout } | null = null;
    let above = 0;
    for (const block of textRef.current.blocks) {
      const layout = layoutOf(block);
      if (!layout) continue;
      if (point.y < layout.y) continue;
      if (point.y > layout.y + lastLine(layout)) {
        above = Math.max(above, block.start + block.text.length);
        continue;
      }
      if (!on || layout.x <= point.x) on = { block, layout };
    }
    if (!on) return above;
    const { block, layout } = on;
    return block.start + TextLayoutUtils.offset(layout, block.text, point);
  };

  /** Where the character at an offset is drawn, in Ink's coordinates. */
  const pointAt = (offset: number): Point | null => {
    const block = textRef.current.blocks.findLast((block) => block.start <= offset);
    const layout = block && layoutOf(block);
    if (!block || !layout) return null;
    return TextLayoutUtils.point(
      layout,
      block.text,
      Math.min(offset - block.start, block.text.length)
    );
  };

  /** A point the mouse reported from the top left of this element, in Ink's coordinates. */
  const toLayout = (event: Point) => {
    const root = ref.current;
    if (!root) return event;
    const { x, y } = measureElement(root);
    return { x: x + event.x, y: y + event.y };
  };

  const notify = useEffectEvent((selection: TextSelection | null) =>
    onSelectionChange?.(selection ? selecting.selected() : "")
  );

  const selecting = useSelection({
    value: () => textRef.current.value,
    isActive: !isNested,
    vertical: (from, direction) => {
      const point = pointAt(from);
      if (!point) return from;
      return offsetAt({ x: point.x, y: point.y + direction });
    }
  });
  const { selection, setSelection } = selecting;

  useEffect(() => {
    notify(selection);
  }, [selection]);

  const { mouseRef } = useMouseInput({
    onClick: ({ event }) => {
      read();
      selecting.press(offsetAt(toLayout(event)), event.time);
    },
    onDrag: ({ event }) => selecting.drag(offsetAt(toLayout(event))),
    isActive: !isNested
  });

  // A press anywhere else lets the selection go, but for one on its menu.
  useMouse(
    (event) => {
      const root = ref.current;
      if (event.type !== "down" || !root) return;
      const rows = terminalRows();
      const menuNode = menuRef.current;
      if (menuNode && contains(getBounds(menuNode, rows), event)) return;
      const isInside = contains(getBounds(root, rows), event) && !isCovered(root, event, rows);
      if (!isInside) setSelection(null);
    },
    { isActive: !!selection }
  );

  // The keys only come here while the selection held is this one.
  useInput(
    (input: string, key: Key) => {
      if (key.escape) {
        setSelection(null);
        return;
      }
      // Read again, for anything that has come in since.
      read();
      selecting.handleKey(input, key);
    },
    { isActive: !!selection }
  );

  const [highlights, setHighlights] = useState<TextRow[]>([]);

  // Read from the layout Ink computed for the last frame, only there once it is committed.
  const measure = useEffectEvent((selected: TextSelection | null) => {
    const root = ref.current;
    let next: TextRow[] = [];
    if (root && selected) {
      const [start, end] = selected[0] < selected[1] ? selected : [selected[1], selected[0]];
      const { blocks } = read();
      const pieces = blocks.flatMap((block) => {
        const from = Math.max(start, block.start) - block.start;
        const to = Math.min(end, block.start + block.text.length) - block.start;
        return from < to ? [{ node: block.node, start: from, end: to }] : [];
      });
      next = TextLayoutUtils.rows(root, pieces);
    }
    setHighlights((previous) => (isSame(previous, next) ? previous : next));
  });

  useEffect(() => {
    measure(selection);
    if (!selection) return;
    const interval = setInterval(() => measure(selection), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [selection]);

  const isOffering = !!menu && highlights.length > 0;
  useMouseLayer(menuRef, isOffering);

  const dismiss = useCallback(() => setSelection(null), [setSelection]);
  const mergedRef = useMergedRef(ref, mouseRef, ownRef);

  if (isNested) return <Box {...props}>{children}</Box>;

  const first = highlights[0];
  const last = highlights.at(-1);

  return (
    <Box ref={mergedRef} flexDirection="column" {...props}>
      <SelectableContext value={true}>{children}</SelectableContext>
      <Box ref={highlightsRef} position="absolute" top={0} left={0}>
        {highlights.map((row) => (
          <Box key={`${row.x}:${row.y}`} position="absolute" top={row.y} left={row.x}>
            <Text
              color={theme.colors.selection}
              backgroundColor={theme.colors.selectionBackground}
              wrap="truncate-end"
            >
              {row.text}
            </Text>
          </Box>
        ))}
      </Box>
      {isOffering && first && last && (
        // Over the selection, or under it where there is no row above.
        <Box
          ref={menuRef}
          position="absolute"
          top={first.y > 0 ? first.y - 1 : last.y + 1}
          left={first.x}
        >
          {menu({ text: selecting.selected().trim(), dismiss })}
        </Box>
      )}
    </Box>
  );
}

/**
 * What is drawn inside a `Selectable` but is not part of its text — line numbers beside code,
 * buttons — which is never found or selected.
 */
export function Unselectable(props: BoxProps) {
  const ref = useMergedRef(TextLayoutUtils.ignore, props.ref);
  return <Box {...props} ref={ref} />;
}
