import { type DOMElement, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  compareDrawOrder,
  contains,
  getBounds,
  getVisibleBounds,
  isCovered,
  withMeasureCache
} from "./geometry.ts";
import type { Bounds, MouseEvent } from "./mouse.ts";
import { withPress } from "./press.ts";
import { isMouseStdin } from "./stdin.ts";

// 1000 reports presses, 1006 uses SGR coordinates, 1002 adds dragging, and 1003 adds all pointer
// motion. Only the narrowest mode still needed is asked for: motion floods the input.
const TRACKING = "\x1b[?1000h\x1b[?1006h";
const TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";
const DRAG = "\x1b[?1002h";
const DRAG_OFF = "\x1b[?1002l";
const MOTION = "\x1b[?1003h";
const MOTION_OFF = "\x1b[?1003l";

/** What a target's handlers are called with: the element, and the event from its top left. */
export interface MouseTargetEvent {
  /** Which of the target's elements, by the index it was registered at. */
  index: number;
  /** The event, with `x` and `y` from the element's top left. */
  event: MouseEvent;
}

export interface MouseClickEvent extends MouseTargetEvent {
  /** Keeps the press from reaching the targets drawn beneath this one. */
  stopPropagation: () => void;
  /** The press in screen coordinates: the same object for every target it reaches. */
  nativeEvent: MouseEvent;
}

/** A set of elements taking high-level events, as `useMouseInput` registers them. */
export interface MouseTarget {
  elements: () => readonly (DOMElement | undefined)[];
  rows: () => number;
  onClick?: (event: MouseClickEvent) => void;
  onDrag?: (event: MouseTargetEvent) => void;
  onDragEnd?: (event: MouseTargetEvent) => void;
  onHoverStart?: (event: MouseTargetEvent) => void;
  onHoverEnd?: (event: MouseTargetEvent) => void;
  /** Elements under the pointer, by index. */
  hovers: Set<number>;
  /** The last point each drag reached, which a drag whose release never came ends on. */
  drags: Map<number, MouseEvent>;
}

interface Subscription {
  listener?: (event: MouseEvent) => void;
  target?: MouseTarget;
  motion: boolean;
  drag: boolean;
}

interface Session {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  subscriptions: Set<Subscription>;
  reporting: "none" | "drag" | "motion";
  dispatch: (event: MouseEvent) => void;
}

const sessions = new Set<Session>();

const relative = (event: MouseEvent, bounds: Bounds): MouseEvent => ({
  ...event,
  x: event.x - bounds.x,
  y: event.y - bounds.y
});

/** Keeps a point the pointer left the element with inside of it. */
const clamped = (event: MouseEvent, bounds: Bounds): MouseEvent => ({
  ...event,
  x: Math.min(Math.max(event.x - bounds.x, 0), Math.max(0, bounds.width - 1)),
  y: Math.min(Math.max(event.y - bounds.y, 0), Math.max(0, bounds.height - 1))
});

interface Hit {
  target: MouseTarget;
  index: number;
  element: DOMElement;
  event: MouseEvent;
}

/**
 * Hands an event to every target. Drags and hovers are each target's own; a press goes to the
 * targets under it from the topmost down, until one stops it.
 */
const dispatchTargets = (targets: MouseTarget[], event: MouseEvent) => {
  if (event.type === "wheel") return;
  const hits: Hit[] = [];

  for (const target of targets) {
    const rows = target.rows();
    const elements = target.elements();
    for (let index = 0; index < elements.length; index++) {
      // Registering by index leaves holes behind when one unmounts.
      const element = elements[index];
      if (!element) continue;
      const bounds = getBounds(element, rows);

      // A drag follows the pointer out of the element, held to its edge, and ends wherever the
      // button comes up. A release past the terminal's window may never be reported, which a move
      // with no button held, or a fresh press, gives away.
      const last = target.drags.get(index);
      if (last) {
        const isLost = event.type === "down" || (event.type === "move" && event.button === "none");
        if (event.type === "up" || isLost) {
          target.drags.delete(index);
          target.onDragEnd?.({ index, event: clamped(isLost ? last : event, bounds) });
        } else if (event.type === "move") {
          target.drags.set(index, event);
          target.onDrag?.({ index, event: clamped(event, bounds) });
        }
      }

      const visible = getVisibleBounds(element, rows);
      const isOver = !!visible && contains(visible, event) && !isCovered(element, event, rows);
      if (isOver !== target.hovers.has(index)) {
        if (isOver) target.hovers.add(index);
        else target.hovers.delete(index);
        (isOver ? target.onHoverStart : target.onHoverEnd)?.({
          index,
          event: relative(event, bounds)
        });
      }
      if (isOver && event.type === "down")
        hits.push({ target, index, element, event: relative(event, bounds) });
    }
  }

  if (!hits.length) return;
  hits.sort((a, b) => compareDrawOrder(b.element, a.element));
  let stopped = false;
  withPress(event, () => {
    for (const { target, index, event: local } of hits) {
      target.drags.set(index, event);
      target.onClick?.({
        index,
        event: local,
        nativeEvent: event,
        stopPropagation: () => {
          stopped = true;
        }
      });
      if (stopped) break;
    }
  });
};

const sync = (session: Session) => {
  let next: Session["reporting"] = "none";
  for (const item of session.subscriptions) {
    if (item.motion) {
      next = "motion";
      break;
    }
    if (item.drag) next = "drag";
  }
  if (next === session.reporting) return;
  if (session.reporting === "motion") session.stdout.write(MOTION_OFF);
  else if (session.reporting === "drag") session.stdout.write(DRAG_OFF);
  if (next === "motion") session.stdout.write(MOTION);
  else if (next === "drag") session.stdout.write(DRAG);
  // The tracking modes are exclusive on xterm-compatible terminals, and turning one off does not
  // restore the click mode that was on before it.
  else session.stdout.write(TRACKING);
  session.reporting = next;
};

const stop = (session: Session) => {
  session.stdin.off("mouse", session.dispatch);
  session.stdout.write(MOTION_OFF + DRAG_OFF + TRACKING_OFF);
  sessions.delete(session);
  if (!sessions.size) process.off("exit", stopAll);
};

// `process.exit` skips React's cleanup, which would leave the shell reporting clicks.
const stopAll = () => {
  for (const session of sessions) stop(session);
};

let warned = false;

const subscribe = (
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  subscription: Subscription
) => {
  if (!warned && !isMouseStdin(stdin)) {
    warned = true;
    console.warn(
      "[better-ink-ui] The mouse needs Ink's stdin wrapped: render with this library's `render`, or pass `createStdin(process.stdin)` as Ink's `stdin`. Without it, mouse reports are typed in as text."
    );
  }
  let session = [...sessions].find((item) => item.stdin === stdin && item.stdout === stdout);
  if (!session) {
    const subscriptions = new Set<Subscription>();
    session = {
      stdin,
      stdout,
      subscriptions,
      reporting: "none",
      dispatch: (event) =>
        withMeasureCache(() => {
          const targets: MouseTarget[] = [];
          for (const item of [...subscriptions]) {
            item.listener?.(event);
            if (item.target) targets.push(item.target);
          }
          if (targets.length) dispatchTargets(targets, event);
        })
    };
    if (!sessions.size) process.on("exit", stopAll);
    sessions.add(session);
    stdin.on("mouse", session.dispatch);
    stdout.write(TRACKING);
  }
  const current = session;
  current.subscriptions.add(subscription);
  sync(current);
  return () => {
    current.subscriptions.delete(subscription);
    if (!current.subscriptions.size) stop(current);
    else sync(current);
  };
};

/**
 * Turns on mouse reporting for as long as it is subscribed to, and hands every report on.
 * `listener` and `target` must keep their identity across renders.
 */
export const useMouseSubscription = (
  subscription: Omit<Subscription, "motion" | "drag">,
  { motion, drag, isActive }: { motion: boolean; drag: boolean; isActive: boolean }
) => {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const { listener, target } = subscription;

  useEffect(() => {
    if (!isActive || !isRawModeSupported) return;
    setRawMode(true);
    const unsubscribe = subscribe(stdin, stdout, { listener, target, motion, drag });
    return () => {
      unsubscribe();
      setRawMode(false);
    };
  }, [stdin, stdout, setRawMode, isRawModeSupported, isActive, motion, drag, listener, target]);
};

/**
 * Every mouse report, anywhere on screen: presses, releases, wheel turns and, while asked for,
 * movement. Terminals only report what some subscriber needs, so ask for `drag` or `motion` only
 * while they are needed. For events on an element, use `useMouseInput`.
 */
export const useMouse = (
  handler: (event: MouseEvent) => void,
  {
    motion = false,
    drag = false,
    isActive = true
  }: {
    /** Reports every move of the pointer, held or not. */
    motion?: boolean;
    /** Reports moves made while a button is held. */
    drag?: boolean;
    isActive?: boolean;
  } = {}
) => {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  // The same function for the life of the component, so the subscription is never renewed only
  // because the handler is a new closure.
  const listener = useCallback((event: MouseEvent) => latest.current(event), []);
  useMouseSubscription({ listener }, { motion, drag, isActive });
};
