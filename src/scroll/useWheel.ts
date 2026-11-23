import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "../input/mouse.ts";
import { useMouse } from "../input/useMouse.ts";

/**
 * What a wheel handler did with a turn: `moved` something (or kept it from what is around it),
 * `passed` it on to whatever is around
 * it, or found itself `unsettled` — scrolled further than its last layout, so the views nested in
 * it are still laid out where they were, and the one that will be under the pointer cannot be told
 * yet. An unsettled turn is held and offered again once the view has been drawn.
 */
export type WheelResult = "moved" | "passed" | "unsettled";
export type WheelHandler = (event: MouseEvent) => WheelResult;

/** The handlers of what scrolls inside a view, which the view offers the wheel to first. */
export const WheelContext = createContext<Set<WheelHandler> | null>(null);

/**
 * How long a turn waits on a view to settle before it is tried again, and how many times it is
 * tried. Ink draws at 30fps, so a turn held for this long is never one that would have been seen.
 */
const WHEEL_FRAME = 16;
const WHEEL_RETRIES = 10;

/** Turns held for an unsettled view, played in order once it has been drawn. */
const createHeldTurns = () => {
  const queue: MouseEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let offer: WheelHandler = () => "passed";

  const replay = () => {
    timer = undefined;
    for (let event = queue[0]; event; event = queue[0]) {
      if (offer(event) === "unsettled" && retries++ < WHEEL_RETRIES) {
        timer = setTimeout(replay, WHEEL_FRAME);
        return;
      }
      queue.shift();
      retries = 0;
    }
  };

  return {
    push(event: MouseEvent, handler: WheelHandler) {
      offer = handler;
      // Turns behind held ones wait their turn, so a flick keeps its order.
      if (queue.length) {
        queue.push(event);
        return;
      }
      if (handler(event) !== "unsettled") return;
      queue.push(event);
      timer = setTimeout(replay, WHEEL_FRAME);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
      retries = 0;
    }
  };
};

/**
 * Takes the wheel for something that scrolls. The wheel turns over whatever the pointer rests on,
 * so views side by side each answer for themselves, focused or not. Like a browser, a view nested
 * in another is offered each turn first, and only once it passes it on — at the edge it is being
 * turned towards — does the view around it move. Only the outermost listens to the mouse.
 *
 * The handler decides whether the turn is over it, and must return `passed` when it is not.
 * Whatever it renders inside should be wrapped in `<WheelContext value={nested}>` so what scrolls
 * in there is offered turns before it; `nested` holds their handlers.
 */
export const useWheel = (handler: WheelHandler, { isActive = true } = {}) => {
  const parent = useContext(WheelContext);
  const [nested] = useState(() => new Set<WheelHandler>());
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const [stable] = useState<WheelHandler>(
    () => (event: MouseEvent) => (isActiveRef.current ? latest.current(event) : "passed")
  );

  useEffect(() => {
    if (!parent) return;
    parent.add(stable);
    return () => {
      parent.delete(stable);
    };
  }, [parent, stable]);

  const [held] = useState(createHeldTurns);
  useEffect(() => () => held.cancel(), [held]);

  useMouse(
    (event) => {
      if (event.type === "wheel" && event.deltaY !== 0) held.push(event, stable);
    },
    { isActive: isActive && !parent }
  );

  return { nested };
};
