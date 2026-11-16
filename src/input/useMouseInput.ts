import { type DOMElement, useStdout } from "ink";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { addMouseLayer } from "./geometry.ts";
import {
  type MouseClickEvent,
  type MouseTarget,
  type MouseTargetEvent,
  useMouseSubscription
} from "./useMouse.ts";

export interface MouseInputHandlers {
  /**
   * A press on the element, where nothing drawn over it took the mouse. Presses go to the topmost
   * element first, and on to those beneath unless one calls `stopPropagation`.
   */
  onClick?: (event: MouseClickEvent) => void;
  /** The pointer moving while held after a press on the element, wherever it goes. */
  onDrag?: (event: MouseTargetEvent) => void;
  /** The button coming up after a press on the element, wherever it does. */
  onDragEnd?: (event: MouseTargetEvent) => void;
  /** The pointer coming over the element. */
  onHoverStart?: (event: MouseTargetEvent) => void;
  /** The pointer leaving the element. */
  onHoverEnd?: (event: MouseTargetEvent) => void;
  isActive?: boolean;
}

/**
 * Presses, drags and hovers on elements. Attach `mouseRef` to one element, or to several by index
 * (`ref={(node) => mouseRef(node, i)}`), which handlers are told of. Only what can be seen of an
 * element takes the mouse: rows scrolled out of a view, or covered by a layer, do not.
 *
 * A drag follows the pointer out of the element, held to its edges, until the button comes up.
 */
export const useMouseInput = ({
  onClick,
  onDrag,
  onDragEnd,
  onHoverStart,
  onHoverEnd,
  isActive = true
}: MouseInputHandlers = {}) => {
  // Read as each event is dispatched rather than through `useWindowSize`, which would add a resize
  // listener, and a render on every resize, to every button on screen.
  const { stdout } = useStdout();
  const elements = useRef<(DOMElement | undefined)[]>([]);
  const stdoutRef = useRef(stdout);

  const [target] = useState<MouseTarget>(() => ({
    elements: () => elements.current,
    rows: () => (stdoutRef.current as NodeJS.WriteStream).rows ?? 24,
    hovers: new Set(),
    drags: new Map()
  }));

  useLayoutEffect(() => {
    stdoutRef.current = stdout;
    target.onClick = onClick;
    target.onDrag = onDrag;
    target.onDragEnd = onDragEnd;
    target.onHoverStart = onHoverStart;
    target.onHoverEnd = onHoverEnd;
  });

  // Hovers and drags left over from while it was active would never end otherwise.
  useEffect(() => {
    if (isActive) return;
    target.hovers.clear();
    target.drags.clear();
  }, [isActive, target]);

  useMouseSubscription(
    { target },
    { motion: !!onHoverStart || !!onHoverEnd, drag: !!onDrag, isActive }
  );

  const mouseRef = useCallback((element: DOMElement | null, index = 0) => {
    if (element) elements.current[index] = element;
    else delete elements.current[index];
  }, []);

  return { mouseRef };
};

/**
 * Makes an element an overlay while active: where it is drawn, only what is inside it takes the
 * mouse, rather than whatever it covers — a menu over a list, a dialog over the app.
 */
export const useMouseLayer = (ref: RefObject<DOMElement | null>, isActive = true) => {
  useEffect(() => {
    if (!isActive || !ref.current) return;
    return addMouseLayer(ref.current);
  }, [ref, isActive]);
};
