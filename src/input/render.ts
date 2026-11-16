import { type Instance, render as inkRender, type RenderOptions } from "ink";
import type { ReactNode } from "react";
import { createStdin } from "./stdin.ts";

/**
 * Ink's `render`, with its stdin wrapped by {@link createStdin} so the mouse works and keys are
 * framed and delivered one at a time. The wrapper is destroyed once the app unmounts.
 */
export const render = (node: ReactNode, options: RenderOptions = {}): Instance => {
  const stdin = createStdin(options.stdin ?? process.stdin);
  const instance = inkRender(node, { ...options, stdin: stdin as unknown as NodeJS.ReadStream });
  const destroy = () => stdin.destroy();
  instance.waitUntilExit().then(destroy, destroy);
  return instance;
};
