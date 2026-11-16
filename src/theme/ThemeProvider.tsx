import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type Color, resolveColor } from "./color.ts";

/**
 * The colors this library draws its own parts in. Each is a {@link Color}, so it may name another
 * color in the theme. Left undefined, Ink's default is used.
 */
export interface ThemeColors {
  /** Text with no color of its own. */
  text?: Color;
  /** Borders with no color of their own. */
  border?: Color;
  /** A scroll view's handle. */
  scrollbar?: Color;
  /** A scroll view's handle while it is hovered or dragged. */
  scrollbarActive?: Color;
  /** Selected text. */
  selection?: Color;
  /** The background of selected text. */
  selectionBackground?: Color;
  /** A text area's placeholder, which is otherwise its text dimmed. */
  placeholder?: Color;
  [name: string]: Color | undefined;
}

export interface Theme {
  /**
   * Named colors, which every `color`, `backgroundColor` and `borderColor` in this library accepts
   * by name, and the colors of its own parts.
   */
  colors: ThemeColors;
  /** What translucent colors are blended over: the terminal's background, ideally. */
  background?: Color;
  /** The border style a `<Box border>` is drawn with. */
  borderStyle: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "classic";
}

export const defaultTheme: Theme = {
  colors: {
    scrollbar: "gray",
    scrollbarActive: "white",
    selection: "black",
    selectionBackground: "blueBright"
  },
  borderStyle: "round"
};

interface ResolvedTheme extends Theme {
  /** A color as Ink draws it, from a theme name, a translucent color or anything Ink accepts. */
  resolve: (color: Color | undefined) => string | undefined;
}

const resolverFor = (theme: Theme): ResolvedTheme => {
  const background = resolveColor(theme.background, theme.colors, undefined);
  // Resolved colors are cached for the life of the theme: most are drawn on every frame.
  const cache = new Map<string, string | undefined>();
  return {
    ...theme,
    resolve: (color) => {
      if (color === undefined) return undefined;
      if (typeof color !== "string") return resolveColor(color, theme.colors, background);
      if (cache.has(color)) return cache.get(color);
      const resolved = resolveColor(color, theme.colors, background);
      cache.set(color, resolved);
      return resolved;
    }
  };
};

const ThemeContext = createContext<ResolvedTheme>(resolverFor(defaultTheme));

/**
 * The theme for everything inside: named colors, the background translucent colors are blended
 * over, and the colors of this library's own parts. Merged over the theme around it, so a nested
 * provider only overrides what it sets.
 */
export function ThemeProvider({
  theme,
  children
}: {
  theme: Partial<Omit<Theme, "colors">> & { colors?: ThemeColors };
  children?: ReactNode;
}) {
  const parent = useContext(ThemeContext);
  const { colors, background, borderStyle } = theme;
  const value = useMemo(
    () =>
      resolverFor({
        colors: { ...parent.colors, ...colors },
        background: background ?? parent.background,
        borderStyle: borderStyle ?? parent.borderStyle
      }),
    [parent, colors, background, borderStyle]
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export const useTheme = () => useContext(ThemeContext);

/** A color as Ink draws it. */
export const useColor = (color: Color | undefined) => {
  const theme = useContext(ThemeContext);
  return useMemo(() => theme.resolve(color), [theme, color]);
};
