import type { Bounds } from "../input/mouse.ts";

/** The side of its anchor a popover prefers to open on. */
export type PopoverPosition = "top" | "bottom" | "left" | "right";

/** Where along its anchor's side a popover lines up: its start, middle or end. */
export type PopoverAlign = "start" | "center" | "end";

const OPPOSITE: Record<PopoverPosition, PopoverPosition> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left"
};

const clamp = (value: number, min: number, max: number) =>
  // A popover larger than its bounds starts at their start, and runs past their end.
  Math.max(min, Math.min(value, max));

/**
 * Where a popover of `size` is drawn beside `anchor`, kept inside `bounds`, in the same coordinates
 * as both. It opens on the side preferred where it fits there, and on the opposite one where it
 * fits better there; along that side it lines up by `align`, and is then pushed back inside the
 * bounds on both axes.
 */
export const placePopover = ({
  anchor,
  size,
  bounds,
  position = "bottom",
  align = "start",
  offset = 0
}: {
  anchor: Bounds;
  size: { width: number; height: number };
  bounds: Bounds;
  position?: PopoverPosition;
  align?: PopoverAlign;
  /** Cells left between the anchor and the popover. */
  offset?: number;
}): { x: number; y: number; position: PopoverPosition } => {
  const vertical = position === "top" || position === "bottom";
  // Worked out along the main axis (away from the anchor) and the cross axis (along its side).
  const main = vertical
    ? {
        start: anchor.y,
        length: anchor.height,
        size: size.height,
        min: bounds.y,
        max: bounds.y + bounds.height
      }
    : {
        start: anchor.x,
        length: anchor.width,
        size: size.width,
        min: bounds.x,
        max: bounds.x + bounds.width
      };
  const cross = vertical
    ? {
        start: anchor.x,
        length: anchor.width,
        size: size.width,
        min: bounds.x,
        max: bounds.x + bounds.width
      }
    : {
        start: anchor.y,
        length: anchor.height,
        size: size.height,
        min: bounds.y,
        max: bounds.y + bounds.height
      };

  const after = main.start + main.length + offset;
  const before = main.start - offset - main.size;
  const room = { after: main.max - after, before: main.start - offset - main.min };
  const prefersAfter = position === "bottom" || position === "right";
  const preferred = prefersAfter ? room.after : room.before;
  const opposite = prefersAfter ? room.before : room.after;
  const flips = preferred < main.size && opposite > preferred;
  const isAfter = prefersAfter !== flips;

  const mainAt = clamp(isAfter ? after : before, main.min, main.max - main.size);
  const crossAt = clamp(
    align === "start"
      ? cross.start
      : align === "end"
        ? cross.start + cross.length - cross.size
        : cross.start + Math.floor((cross.length - cross.size) / 2),
    cross.min,
    cross.max - cross.size
  );

  return {
    x: vertical ? crossAt : mainAt,
    y: vertical ? mainAt : crossAt,
    position: flips ? OPPOSITE[position] : position
  };
};
