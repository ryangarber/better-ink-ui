import type { Color } from "../theme/color.ts";

/** A position in the value, as the line it is on and the column along it. */
export type TextareaCursor = [line: number, column: number];

/**
 * A selected range of text, by offsets: from where it was started to where it was taken to, so
 * `anchor` may come after `focus`.
 */
export type TextSelection = [anchor: number, focus: number];

/** One row of the value as it is drawn, after long lines are wrapped. */
export interface TextareaRow {
  /** The logical line the row is part of. */
  line: number;
  /** The column of that line the row starts at. */
  column: number;
  text: string;
}

/** How a run of text is drawn. Colors may be theme names or translucent. */
export interface TextareaStyle {
  color?: Color;
  backgroundColor?: Color;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

/**
 * Styles by label, with `text` for whatever no label claimed. A label of several joined by `+` is
 * drawn in all of their styles, the later over the earlier: `"link+pending"`.
 */
export type TextareaStyles = Readonly<Record<string, TextareaStyle>>;

/** A run of the value painted under a label, with a style of its own over the label's. */
export interface TextareaRange {
  start: number;
  end: number;
  label: string;
  style?: TextareaStyle;
}

/**
 * A rule that paints the value: whatever a pattern matches, under a label (or the label worked out
 * from the match, or none), or the ranges worked out from the value as a whole. Rules are read in
 * order, and the first to claim a character keeps it.
 */
export type TextareaLabel =
  | {
      pattern: RegExp;
      label: string | ((match: RegExpMatchArray) => string | undefined);
    }
  | { ranges: (value: string) => Iterable<TextareaRange> };

export type TextareaLabels = readonly TextareaLabel[];

/**
 * A run of the value handled as one: the cursor steps over it and never rests inside it, a
 * selection reaching into it takes all of it, and a delete takes it out whole. Atoms are how a
 * mention, a chip or a placeholder token stands in the text. With a `label`, it is painted under
 * it ahead of every rule in `labels`.
 */
export interface TextareaAtom {
  start: number;
  end: number;
  label?: string;
  style?: TextareaStyle;
}

/**
 * An edit made whole in place of a key: the value it leaves, and the selection over it, collapsed
 * to the cursor where its two ends meet.
 */
export interface TextareaEdit {
  value: string;
  selection: TextSelection;
}
