import { type ReactNode, useState } from "react";
import { Box, type BoxProps } from "../layout/Box.tsx";
import { useMergedRef } from "../shared/useMergedRef.ts";
import type { MouseClickEvent } from "./useMouse.ts";
import { useMouseInput } from "./useMouseInput.ts";

export interface PressableState {
  isHovered: boolean;
  isPressed: boolean;
}

export interface PressableProps extends Omit<BoxProps, "children"> {
  /** A left press. Presses stop here rather than reaching what is drawn beneath, unless it returns `false`. */
  onPress?: (event: MouseClickEvent) => boolean | undefined | void;
  /** Neither hovers nor takes presses. */
  disabled?: boolean;
  children?: ReactNode | ((state: PressableState) => ReactNode);
}

/**
 * A box that can be pressed with the mouse, drawing itself from whether it is hovered or held: the
 * base of a button, a link, a row. Hover is only tracked while children are drawn from it, since
 * it turns on reporting every move of the pointer.
 */
export function Pressable({ onPress, disabled = false, children, ref, ...props }: PressableProps) {
  const [isHovered, setHovered] = useState(false);
  const [isPressed, setPressed] = useState(false);
  const tracksState = typeof children === "function";

  const { mouseRef } = useMouseInput({
    onClick: (event) => {
      if (event.event.button !== "left") return;
      if (tracksState) setPressed(true);
      if (onPress?.(event) !== false) event.stopPropagation();
    },
    onDragEnd: tracksState ? () => setPressed(false) : undefined,
    onHoverStart: tracksState ? () => setHovered(true) : undefined,
    onHoverEnd: tracksState ? () => setHovered(false) : undefined,
    isActive: !disabled
  });
  const mergedRef = useMergedRef(mouseRef, ref);
  const state = { isHovered: isHovered && !disabled, isPressed: isPressed && !disabled };

  return (
    <Box ref={mergedRef} flexShrink={0} {...props}>
      {typeof children === "function" ? children(state) : children}
    </Box>
  );
}
