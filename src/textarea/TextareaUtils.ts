import stringWidth from "string-width";
import type {
  TextareaAtom,
  TextareaCursor,
  TextareaLabels,
  TextareaRow,
  TextareaStyle,
  TextareaStyles,
  TextSelection
} from "./types.ts";

/** Columns a tab is drawn across. */
export const TAB_WIDTH = 4;

/** The label of text no rule has claimed. */
export const TEXT_LABEL = "text";

/** What a character is painted under: a label, and a style of its own over it. */
export interface TextareaPaint {
  label: string;
  style?: TextareaStyle;
}

/** The paint of text no rule has claimed. */
export const TEXT_PAINT: TextareaPaint = { label: TEXT_LABEL };

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type WordKind = "word" | "symbol" | "space";

/** The run a character belongs to. A newline belongs to none, so a run never crosses a line. */
const wordKind = (char: string | undefined): WordKind | null => {
  if (char === undefined || char === "\n") return null;
  if (/\s/.test(char)) return "space";
  return /[\p{L}\p{N}_]/u.test(char) ? "word" : "symbol";
};

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/** Styles resolved by label, per set of styles, which outlive a render. */
const RESOLVED = new WeakMap<TextareaStyles, Map<string, TextareaStyle>>();
const NO_STYLES: TextareaStyles = {};

/**
 * Rows a line wraps to at a width, kept between layouts so an edit only wraps the lines it touched
 * — typing into a long paste re-wraps one line, not all of them.
 */
export type TextareaRowCache = Map<string, readonly { column: number; text: string }[]>;

/**
 * The geometry of a text area: how the value wraps into rows, scrolls under the viewport, is
 * stepped across by the cursor, and is painted.
 */
export const TextareaUtils = {
  /** The style a label is drawn in, which for labels joined by `+` is all of theirs. */
  style: (styles: TextareaStyles | undefined, label: string): TextareaStyle => {
    const key = styles ?? NO_STYLES;
    let resolved = RESOLVED.get(key);
    if (!resolved) {
      resolved = new Map();
      RESOLVED.set(key, resolved);
    }
    let style = resolved.get(label);
    if (!style) {
      style = Object.assign(
        {},
        ...label.split("+").map((part) => (part === TEXT_LABEL ? {} : key[part]))
      ) as TextareaStyle;
      resolved.set(label, style);
    }
    return style;
  },

  /** The text split into graphemes, each with the offset it starts at. */
  graphemes: (text: string) =>
    Array.from(SEGMENTER.segment(text), ({ segment, index }) => ({ segment, index })),

  /** Columns a single grapheme takes up once drawn. */
  width: (grapheme: string) => {
    if (grapheme.length === 0) return 0;
    if (grapheme === "\t") return TAB_WIDTH;
    const code = grapheme.charCodeAt(0);
    if (grapheme.length === 1) {
      if (code >= 0x20 && code < 0x7f) return 1;
      if (code < 0x20) return 0;
    }
    return stringWidth(grapheme);
  },

  /** Columns a run of text takes up. */
  textWidth: (text: string) => {
    let width = 0;
    for (const { segment } of SEGMENTER.segment(text)) width += TextareaUtils.width(segment);
    return width;
  },

  /** Where the grapheme before the offset starts. */
  previous: (value: string, offset: number) => {
    const at = Math.min(offset, value.length);
    if (at <= 0) return 0;
    // Only the segment around the offset is found, rather than every one before it.
    return SEGMENTER.segment(value).containing(at - 1)?.index ?? 0;
  },

  /** Where the grapheme after the offset ends. */
  next: (value: string, offset: number) => {
    if (offset >= value.length) return value.length;
    const segment = SEGMENTER.segment(value).containing(Math.max(0, offset));
    return segment ? segment.index + segment.segment.length : value.length;
  },

  /**
   * Lays the value out into the rows it is drawn in.
   *
   * @param width Columns the text has, which is where lines wrap.
   * @param cursor Where the cursor is drawn, or null while it is not.
   * @param cache Rows by line from the last layout, which unchanged lines are taken from.
   */
  rows: ({
    value,
    width,
    cursor,
    cache
  }: {
    value: string;
    width: number;
    cursor: TextareaCursor | null;
    cache?: TextareaRowCache;
  }): TextareaRow[] => {
    const rows: TextareaRow[] = [];
    const next: TextareaRowCache | undefined = cache && new Map();
    const lines = value.split("\n");

    for (let line = 0; line < lines.length; line++) {
      const text = lines[line] ?? "";
      let wrapped = cache?.get(text);
      if (!wrapped) {
        const chunks: { column: number; text: string }[] = [];
        if (width <= 0 || text.length === 0) chunks.push({ column: 0, text });
        else {
          let chunk = "";
          let chunkWidth = 0;
          let column = 0;
          for (const { segment } of SEGMENTER.segment(text)) {
            const size = TextareaUtils.width(segment);
            if (chunkWidth + size > width && chunk.length > 0) {
              chunks.push({ column, text: chunk });
              column += chunk.length;
              chunk = "";
              chunkWidth = 0;
            }
            chunk += segment;
            chunkWidth += size;
          }
          chunks.push({ column, text: chunk });
        }
        wrapped = chunks;
      }
      next?.set(text, wrapped);
      for (const chunk of wrapped) rows.push({ line, column: chunk.column, text: chunk.text });

      // A line filling its last row exactly leaves the cursor nowhere to sit, so a row is opened.
      const last = wrapped.at(-1);
      if (
        cursor &&
        width > 0 &&
        line === cursor[0] &&
        cursor[1] === text.length &&
        text.length > 0 &&
        last &&
        TextareaUtils.textWidth(last.text) === width
      )
        rows.push({ line, column: text.length, text: "" });
    }

    if (cache && next) {
      cache.clear();
      for (const [key, rows] of next) cache.set(key, rows);
    }
    return rows;
  },

  /** Which row the cursor is on, or -1 when it is on none. */
  row: ({
    rows,
    cursor: [line, column]
  }: {
    rows: readonly TextareaRow[];
    cursor: TextareaCursor;
  }) => {
    // Rows are in line order, so the cursor's line is found by halving.
    let low = 0;
    let high = rows.length - 1;
    let first = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const row = rows[middle] as TextareaRow;
      if (row.line < line) low = middle + 1;
      else {
        if (row.line === line) first = middle;
        high = middle - 1;
      }
    }
    if (first < 0) return -1;
    let index = first;
    for (let i = first + 1; i < rows.length; i++) {
      const row = rows[i] as TextareaRow;
      if (row.line !== line || row.column > column) break;
      index = i;
    }
    return index;
  },

  /**
   * The row the viewport starts at, moved only as far as it takes to bring the cursor into view.
   *
   * @param height Rows the viewport shows at once.
   */
  scroll: ({
    offset,
    index,
    count,
    height
  }: {
    offset: number;
    index: number;
    count: number;
    height: number;
  }) => {
    const viewport = Math.max(1, height);
    let next = offset;
    if (index >= 0 && index < offset) next = index;
    else if (index >= offset + viewport) next = index - viewport + 1;
    return Math.min(Math.max(0, count - viewport), Math.max(0, next));
  },

  /**
   * The position a point inside the text area is on, from its top left corner.
   *
   * @param offset The row the viewport starts at.
   */
  position: ({
    value,
    rows,
    point,
    offset
  }: {
    value: string;
    rows: readonly TextareaRow[];
    point: { x: number; y: number };
    offset: number;
  }): TextareaCursor => {
    const row = rows[Math.min(Math.max(offset + point.y, 0), rows.length - 1)];
    if (!row) return TextareaUtils.cursor(value, value.length);
    let column = 0;
    let consumed = 0;
    for (const { segment } of SEGMENTER.segment(row.text)) {
      const size = TextareaUtils.width(segment);
      if (point.x < consumed + size) break;
      consumed += size;
      column += segment.length;
    }
    return [row.line, row.column + column];
  },

  /** The cursor as an offset into the value, clamped to it. */
  offset: (value: string, [line, column]: TextareaCursor) => {
    let start = 0;
    for (let current = 0; current < line; current++) {
      const end = value.indexOf("\n", start);
      if (end < 0) break;
      start = end + 1;
    }
    let end = value.indexOf("\n", start);
    if (end < 0) end = value.length;
    return start + Math.max(0, Math.min(column, end - start));
  },

  /** The inverse of {@link TextareaUtils.offset}. */
  cursor: (value: string, offset: number): TextareaCursor => {
    let line = 0;
    let start = 0;
    const to = Math.min(offset, value.length);
    for (
      let index = value.indexOf("\n");
      index >= 0 && index < to;
      index = value.indexOf("\n", index + 1)
    ) {
      line += 1;
      start = index + 1;
    }
    return [line, offset - start];
  },

  /**
   * The offset a step onto the row above or below lands on, holding the column the cursor was
   * drawn at. Off either end, the nearest end of the value.
   */
  vertical: ({
    value,
    rows,
    cursor,
    direction
  }: {
    value: string;
    rows: readonly TextareaRow[];
    cursor: TextareaCursor;
    direction: 1 | -1;
  }) => {
    const index = TextareaUtils.row({ rows, cursor });
    if (index < 0) return TextareaUtils.offset(value, cursor);
    const target = index + direction;
    if (target < 0) return 0;
    if (target >= rows.length) return value.length;
    const row = rows[index] as TextareaRow;
    const x = TextareaUtils.textWidth(row.text.slice(0, Math.max(0, cursor[1] - row.column)));
    return TextareaUtils.offset(
      value,
      TextareaUtils.position({ value, rows, point: { x, y: target }, offset: 0 })
    );
  },

  /**
   * What every character is painted under: the atoms with labels first, then the rules in order.
   * The first to claim a character keeps it.
   */
  paint: (value: string, labels: TextareaLabels, atoms: readonly TextareaAtom[] = []) => {
    const painted: TextareaPaint[] = new Array(value.length).fill(TEXT_PAINT);
    const claim = (start: number, end: number, paint: TextareaPaint) => {
      for (let index = Math.max(0, start); index < Math.min(end, value.length); index++)
        if (painted[index] === TEXT_PAINT) painted[index] = paint;
    };
    for (const atom of atoms)
      if (atom.label) claim(atom.start, atom.end, { label: atom.label, style: atom.style });
    for (const rule of labels) {
      if ("ranges" in rule) {
        for (const range of rule.ranges(value)) claim(range.start, range.end, range);
        continue;
      }
      for (const match of value.matchAll(rule.pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (end === start) continue;
        const label = typeof rule.label === "string" ? rule.label : rule.label(match);
        if (label) claim(start, end, { label });
      }
    }
    return painted;
  },

  /** The selection in order. */
  range: ([anchor, focus]: TextSelection): [start: number, end: number] =>
    anchor <= focus ? [anchor, focus] : [focus, anchor],

  /** The selected text, empty while nothing is selected. */
  selected: (value: string, selection: TextSelection | null | undefined) => {
    if (!selection) return "";
    const [start, end] = TextareaUtils.range(selection);
    return value.slice(start, end);
  },

  /**
   * The run of like characters an offset is in, which a double click takes: a word, a stretch of
   * punctuation, or the space between. The run before the offset wins over space after it, so a
   * click against the end of a word takes the word.
   */
  word: (value: string, offset: number): [start: number, end: number] => {
    const index = Math.max(0, Math.min(offset, value.length));
    const after = wordKind(value[index]);
    const kind = after && after !== "space" ? after : (wordKind(value[index - 1]) ?? after);
    if (!kind) return [index, index];
    let start = index;
    while (start > 0 && wordKind(value[start - 1]) === kind) start -= 1;
    let end = index;
    while (end < value.length && wordKind(value[end]) === kind) end += 1;
    return [start, end];
  },

  /**
   * A selection dragged a word at a time, from the word it started on out to the word reached,
   * pointing the way it was dragged.
   */
  words: (
    value: string,
    [start, end]: [start: number, end: number],
    focused: number
  ): TextSelection => {
    if (focused < start) return [end, TextareaUtils.word(value, focused)[0]];
    if (focused > end) return [start, TextareaUtils.word(value, focused)[1]];
    return [start, end];
  },

  /** The start of the word before the offset, past any whitespace in between. */
  wordStart: (value: string, offset: number) => {
    let index = offset - 1;
    while (index >= 0 && isSpace(value[index])) index -= 1;
    while (index >= 0 && !isSpace(value[index])) index -= 1;
    return index + 1;
  },

  /** The end of the word after the offset, and any whitespace trailing it. */
  wordEnd: (value: string, offset: number) => {
    let index = offset;
    while (index < value.length && !isSpace(value[index])) index += 1;
    while (index < value.length && isSpace(value[index])) index += 1;
    return index;
  },

  /** The atom an offset is strictly inside of. */
  atomAt: (atoms: readonly TextareaAtom[], offset: number) =>
    atoms.find(({ start, end }) => offset > start && offset < end) ?? null,

  /**
   * Where a cursor landing on an offset rests instead, so it is never inside an atom: on past it
   * the way it was travelling from `from`, or out its nearer end when it did not travel.
   */
  snap: (atoms: readonly TextareaAtom[], offset: number, from = offset) => {
    const atom = TextareaUtils.atomAt(atoms, offset);
    if (!atom) return offset;
    if (from <= atom.start) return atom.end;
    if (from >= atom.end) return atom.start;
    return offset - atom.start < atom.end - offset ? atom.start : atom.end;
  },

  /** A selection stretched over every atom it reaches into, pointing the way it did. */
  expand: (atoms: readonly TextareaAtom[], selection: TextSelection): TextSelection => {
    const [start, end] = TextareaUtils.range(selection);
    let from = start;
    let to = end;
    for (const atom of atoms) {
      if (atom.start >= end || atom.end <= start) continue;
      from = Math.min(from, atom.start);
      to = Math.max(to, atom.end);
    }
    if (from === start && to === end) return selection;
    return selection[0] <= selection[1] ? [from, to] : [to, from];
  },

  /**
   * The range a delete at an offset takes: an atom against the cursor or around it whole, then a
   * character — or under `word`, a word cut back to the near edge of any atom it reaches, so one
   * press never takes an atom and the text around it together.
   */
  deletion: (
    value: string,
    atoms: readonly TextareaAtom[],
    offset: number,
    direction: 1 | -1,
    word = false
  ): [start: number, end: number] => {
    for (const { start, end } of atoms) {
      if (offset > start && offset < end) return [start, end];
      if (direction === -1 && offset === end && end > start) return [start, end];
      if (direction === 1 && offset === start && end > start) return [start, end];
    }
    const target = word
      ? direction === -1
        ? TextareaUtils.wordStart(value, offset)
        : TextareaUtils.wordEnd(value, offset)
      : direction === -1
        ? TextareaUtils.previous(value, offset)
        : TextareaUtils.next(value, offset);
    let [start, end] = direction === -1 ? [target, offset] : [offset, target];
    for (const atom of atoms) {
      if (atom.start >= end || atom.end <= start) continue;
      if (direction === -1) start = Math.max(start, atom.end);
      else end = Math.min(end, atom.start);
    }
    return [start, end];
  }
} as const;
