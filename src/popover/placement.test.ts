import { describe, expect, it } from "vitest";
import { placePopover } from "./placement.ts";

const bounds = { x: 0, y: 0, width: 40, height: 20 };
const anchor = { x: 10, y: 5, width: 4, height: 1 };

describe("placePopover", () => {
  it("opens on the side preferred, lined up by align", () => {
    const size = { width: 8, height: 3 };
    expect(placePopover({ anchor, size, bounds })).toEqual({ x: 10, y: 6, position: "bottom" });
    expect(placePopover({ anchor, size, bounds, position: "top", align: "end" })).toEqual({
      x: 6,
      y: 2,
      position: "top"
    });
    expect(placePopover({ anchor, size, bounds, position: "right", offset: 1 })).toEqual({
      x: 15,
      y: 5,
      position: "right"
    });
    expect(
      placePopover({
        anchor,
        size: { width: 8, height: 3 },
        bounds,
        position: "left",
        align: "center"
      })
    ).toEqual({ x: 2, y: 4, position: "left" });
  });

  it("flips where the side preferred is short of room and the other has more", () => {
    const low = { ...anchor, y: 18 };
    expect(placePopover({ anchor: low, size: { width: 8, height: 5 }, bounds })).toEqual({
      x: 10,
      y: 13,
      position: "top"
    });
    // Neither fits: the side with more room, pushed back inside.
    expect(placePopover({ anchor, size: { width: 8, height: 30 }, bounds })).toEqual({
      x: 10,
      y: 0,
      position: "bottom"
    });
  });

  it("stays inside the bounds along the trigger's side", () => {
    const right = { ...anchor, x: 38 };
    expect(placePopover({ anchor: right, size: { width: 10, height: 2 }, bounds }).x).toBe(30);
    expect(
      placePopover({ anchor, size: { width: 60, height: 2 }, bounds: { ...bounds, x: 2 } }).x
    ).toBe(2);
  });
});
