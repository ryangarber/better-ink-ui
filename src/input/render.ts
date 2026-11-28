import { type Instance, render as inkRender, type RenderOptions } from "ink";
import type { ReactNode } from "react";
import { repaintOnResize } from "./repaint.ts";
import { createStdin } from "./stdin.ts";

/**
 * Ink's `render`, with its stdin wrapped by {@link createStdin} so the mouse works and keys are
 * framed and delivered one at a time. On the alternate screen, the frame is drawn whole again
 * after the terminal resizes ({@link repaintOnResize}). Both are undone once the app unmounts.
 */
export const render = (node: ReactNode, options: RenderOptions = {}): Instance => {
  const stdin = createStdin(options.stdin ?? process.stdin);
  const stdout = (options.stdout ?? process.stdout) as NodeJS.WriteStream;
  const instance = inkRender(node, { ...options, stdin: stdin as unknown as NodeJS.ReadStream });

  let current = node;
  const rerender = instance.rerender;
  instance.rerender = (next) => {
    current = next;
    rerender(next);
  };

  const stopRepainting =
    options.alternateScreen && stdout.isTTY
      ? repaintOnResize({ instance, stdout, rerender: () => rerender(current) })
      : undefined;

  const destroy = () => {
    stopRepainting?.();
    stdin.destroy();
  };
  instance.waitUntilExit().then(destroy, destroy);
  return instance;
};
