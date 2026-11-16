import { type DOMElement, Box as InkBox, type BoxProps as InkBoxProps } from "ink";
import { createContext, type ReactNode, type Ref, useContext, useMemo } from "react";
import type { Color } from "../theme/color.ts";
import { type Theme, useColor, useTheme } from "../theme/ThemeProvider.tsx";
import {
  InsideTextContext,
  type TextStyle,
  TextStyleContext,
  useMergedTextStyle
} from "./Text.tsx";

export interface BoxProps
  extends Omit<InkBoxProps, "backgroundColor" | "borderColor" | "borderBackgroundColor">,
    Omit<TextStyle, "backgroundColor"> {
  backgroundColor?: Color;
  /** Inherited by the boxes inside, until one sets its own. */
  borderColor?: Color;
  /** Inherited by the boxes inside, until one sets its own. Defaults to the background. */
  borderBackgroundColor?: Color;
  /**
   * Draws a border on every side: `true` in the theme's border style, or a style of its own.
   * `false` draws none, even with a `borderStyle`. `borderTop` and the like still leave sides out.
   */
  border?: boolean | Theme["borderStyle"];
  ref?: Ref<DOMElement>;
  children?: ReactNode;
}

interface BoxStyle {
  backgroundColor?: Color;
  borderColor?: Color;
  borderBackgroundColor?: Color;
}

const BoxStyleContext = createContext<BoxStyle | undefined>(undefined);

/** The background color the box being drawn in paints, if any does. */
export const useBackgroundColor = () => useContext(BoxStyleContext)?.backgroundColor;

/**
 * Ink's `<Box>`, taking theme colors and translucent colors, handing text styles (`color`, `bold`,
 * `wrap`, …) down to every `<Text>` inside, and border colors down to every box inside.
 *
 * Inside a `<Text>`, where Ink throws for a box, its children are rendered inline instead.
 */
export function Box({
  color,
  dimColor,
  bold,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  backgroundColor: ownBackground,
  borderColor: ownBorderColor,
  borderBackgroundColor: ownBorderBackground,
  border,
  ...props
}: BoxProps) {
  const inherited = useContext(BoxStyleContext);
  const inheritedText = useContext(TextStyleContext);
  const insideText = useContext(InsideTextContext);
  const theme = useTheme();

  const backgroundColor = ownBackground ?? inherited?.backgroundColor;
  const borderColor = ownBorderColor ?? inherited?.borderColor;
  const borderBackgroundColor = ownBorderBackground ?? inherited?.borderBackgroundColor;
  const style = useMemo<BoxStyle>(
    () => ({ backgroundColor, borderColor, borderBackgroundColor }),
    [backgroundColor, borderColor, borderBackgroundColor]
  );
  const textStyle = useMergedTextStyle(
    { color, dimColor, bold, italic, underline, strikethrough, inverse, wrap },
    inheritedText
  );

  // Painted only where it is set, or under an overlay, which covers whatever is beneath it. The
  // box an inherited color comes from has already painted it, and Ink paints every cell of every
  // box given a background on every frame — scrolled out of view or not — so painting it again
  // costs a pass over each cell for every box it is nested in. Text inherits it from Ink itself.
  const paintedBackground = useColor(
    ownBackground ?? (props.position === "absolute" ? inherited?.backgroundColor : undefined)
  );
  const resolvedBorderColor = useColor(borderColor ?? theme.colors.border);
  const resolvedBorderBackground = useColor(borderBackgroundColor ?? backgroundColor);
  // `border={false}` turns a border off, whatever style it is given: a style can then be set once
  // and the border toggled.
  const borderStyle =
    border === false
      ? undefined
      : (props.borderStyle ?? (border === true ? theme.borderStyle : border || undefined));

  const borderProps = useMemo<InkBoxProps>(() => {
    return {
      borderLeft: !!border,
      borderRight: !!border,
      borderTop: !!border,
      borderBottom: !!border
    };
  }, [border]);

  if (insideText) return <>{props.children}</>;

  return (
    <BoxStyleContext value={style}>
      <TextStyleContext value={textStyle}>
        <InkBox
          backgroundColor={paintedBackground}
          borderColor={resolvedBorderColor}
          borderBackgroundColor={borderStyle ? resolvedBorderBackground : undefined}
          {...borderProps}
          {...props}
          borderStyle={borderStyle}
        />
      </TextStyleContext>
    </BoxStyleContext>
  );
}
