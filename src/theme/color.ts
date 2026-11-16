/** A color with its channels from 0 to 255 and, optionally, an alpha from 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/**
 * Anything Ink draws a color from — a name such as `"red"` or `"blueBright"`, `#rrggbb`,
 * `rgb(…)`, `ansi256(…)` — or a name from the theme, or a translucent color (`#rrggbbaa`,
 * `rgba(…)`, `{ r, g, b, a }`), which is blended over the theme's background.
 */
export type Color = string | Rgba;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** Parses a hex, `rgb()`/`rgba()` or object color, or returns null for anything else. */
export const parseColor = (value: Color): Required<Rgba> | null => {
  if (typeof value === "object") {
    return {
      r: clamp(value.r, 0, 255),
      g: clamp(value.g, 0, 255),
      b: clamp(value.b, 0, 255),
      a: value.a === undefined ? 1 : clamp(value.a, 0, 1)
    };
  }
  const text = value.trim();
  const rgb = RGB.exec(text);
  if (rgb) {
    return {
      r: clamp(Number(rgb[1]), 0, 255),
      g: clamp(Number(rgb[2]), 0, 255),
      b: clamp(Number(rgb[3]), 0, 255),
      a: rgb[4] === undefined ? 1 : clamp(Number(rgb[4]), 0, 1)
    };
  }
  if (!text.startsWith("#")) return null;
  let hex = text.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
  if ((hex.length !== 6 && hex.length !== 8) || !/^[\da-f]+$/i.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
};

const hex = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");

/** `top` composited over `bottom` (source over), as an opaque `#rrggbb`. */
export const blendColors = (bottom: Color, top: Color): string | undefined => {
  const b = parseColor(bottom);
  const t = parseColor(top);
  if (!t) return undefined;
  if (!b) return `#${hex(t.r)}${hex(t.g)}${hex(t.b)}`;
  const mix = (over: number, under: number) => over * t.a + under * (1 - t.a);
  return `#${hex(mix(t.r, b.r))}${hex(mix(t.g, b.g))}${hex(mix(t.b, b.b))}`;
};

/**
 * Resolves a color to one Ink can draw: a theme name to its value, and a translucent color to the
 * opaque one it looks like over `background` (or with its alpha dropped, without one). Anything
 * else is handed to Ink as it is.
 */
export const resolveColor = (
  color: Color | undefined,
  colors: Readonly<Record<string, Color | undefined>>,
  background: Color | undefined
): string | undefined => {
  let value = color;
  // Theme names may point at other theme names, but never in a loop.
  for (let depth = 0; typeof value === "string" && depth < 8; depth++) {
    if (!Object.hasOwn(colors, value)) break;
    value = colors[value];
  }
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    // The fast path: what Ink already understands.
    if (!value.startsWith("#") && !/^rgba\(/i.test(value)) return value;
    if (value.startsWith("#") && (value.length === 7 || value.length === 4)) return value;
  }
  const parsed = parseColor(value);
  if (!parsed) return typeof value === "string" ? value : undefined;
  if (parsed.a >= 1) return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
  return blendColors(background ?? "", value);
};
