import { Text as InkText, type TextProps as InkTextProps } from "ink";
import { createContext, useContext, useMemo } from "react";
import type { Color } from "../theme/color.ts";
import { useColor, useTheme } from "../theme/ThemeProvider.tsx";

/** The text styles a `<Box>` or `<Text>` hands down to every `<Text>` inside it. */
export interface TextStyle {
  color?: Color;
  backgroundColor?: Color;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: InkTextProps["wrap"];
}

export interface TextProps extends Omit<InkTextProps, keyof TextStyle>, TextStyle {}

export const TextStyleContext = createContext<TextStyle | undefined>(undefined);

/**
 * Whether what renders here sits inside a `<Text>`, where Ink lays out nothing but text: a `<Box>`
 * there throws, and takes the whole app with it. This library's `<Box>` reads it to render its
 * children inline instead, and anything else laid out as a block can too.
 */
export const InsideTextContext = createContext(false);

/**
 * Merges a style over the inherited one. Memoized on the values rather than the objects, so the
 * same object is handed down for as long as the styling holds: a value that changed identity on
 * every render would re-render every text below it, past any `memo` in between.
 */
export const useMergedTextStyle = (own: TextStyle, inherited: TextStyle | undefined): TextStyle => {
  const color = own.color ?? inherited?.color;
  const backgroundColor = own.backgroundColor ?? inherited?.backgroundColor;
  const dimColor = own.dimColor ?? inherited?.dimColor;
  const bold = own.bold ?? inherited?.bold;
  const italic = own.italic ?? inherited?.italic;
  const underline = own.underline ?? inherited?.underline;
  const strikethrough = own.strikethrough ?? inherited?.strikethrough;
  const inverse = own.inverse ?? inherited?.inverse;
  const wrap = own.wrap ?? inherited?.wrap;
  return useMemo(
    () => ({
      color,
      backgroundColor,
      dimColor,
      bold,
      italic,
      underline,
      strikethrough,
      inverse,
      wrap
    }),
    [color, backgroundColor, dimColor, bold, italic, underline, strikethrough, inverse, wrap]
  );
};

/**
 * Ink's `<Text>`, taking theme colors and translucent colors, and inheriting its styles from the
 * `<Box>` or `<Text>` it is drawn in — a `<Box color="gray">` colors all the text inside it.
 */
export function Text({
  color,
  backgroundColor,
  dimColor,
  bold,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  ...props
}: TextProps) {
  const inherited = useContext(TextStyleContext);
  const style = useMergedTextStyle(
    { color, backgroundColor, dimColor, bold, italic, underline, strikethrough, inverse, wrap },
    inherited
  );
  const theme = useTheme();
  const resolvedColor = useColor(style.color ?? theme.colors.text);
  const resolvedBackground = useColor(style.backgroundColor);

  return (
    <TextStyleContext value={style}>
      <InsideTextContext value={true}>
        <InkText
          color={resolvedColor}
          backgroundColor={resolvedBackground}
          dimColor={style.dimColor}
          bold={style.bold}
          italic={style.italic}
          underline={style.underline}
          strikethrough={style.strikethrough}
          inverse={style.inverse}
          wrap={style.wrap}
          {...props}
        />
      </InsideTextContext>
    </TextStyleContext>
  );
}
