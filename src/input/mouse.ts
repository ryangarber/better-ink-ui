/** A position in terminal cells, from the top left of the screen (or of an element, where noted). */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in terminal cells. */
export interface Bounds extends Point {
  width: number;
  height: number;
}

export type MouseButton = "left" | "middle" | "right" | "none";

export interface MouseEvent extends Point {
  type: "down" | "up" | "move" | "wheel";
  button: MouseButton;
  /** Wheel steps, negative up and positive down. Zero for every other event. */
  deltaY: number;
  /** Wheel steps, negative left and positive right. Zero for every other event. */
  deltaX: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** When the report arrived, in milliseconds since the epoch. */
  time: number;
}

/**
 * An SGR mouse report: `ESC [ < button ; column ; row M` for a press (`m` for a release), with
 * coordinates counted from 1.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reports start with ESC
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const BUTTONS: MouseButton[] = ["left", "middle", "right", "none"];
const SHIFT = 4;
const ALT = 8;
const CTRL = 16;
/** The pointer moved rather than a button changing state. */
const MOTION = 32;
/** The wheel turned, with the button bits carrying the direction. */
const WHEEL = 64;

/** Every SGR mouse report in a chunk of terminal input, ignoring anything else it holds. */
export const parseMouse = (data: string, time = Date.now()): MouseEvent[] => {
  const events: MouseEvent[] = [];
  for (const match of data.matchAll(SGR)) {
    const code = Number(match[1]);
    const direction = code & 3;
    const isWheel = (code & WHEEL) !== 0;
    events.push({
      type: isWheel ? "wheel" : (code & MOTION) !== 0 ? "move" : match[4] === "m" ? "up" : "down",
      button: isWheel ? "none" : (BUTTONS[direction] ?? "none"),
      deltaY: isWheel && direction < 2 ? (direction === 0 ? -1 : 1) : 0,
      deltaX: isWheel && direction >= 2 ? (direction === 2 ? -1 : 1) : 0,
      x: Number(match[2]) - 1,
      y: Number(match[3]) - 1,
      shift: (code & SHIFT) !== 0,
      alt: (code & ALT) !== 0,
      ctrl: (code & CTRL) !== 0,
      time
    });
  }
  return events;
};

/** A chunk of terminal input with every mouse report taken out. */
export const stripMouse = (data: string) => data.replace(SGR, "");
