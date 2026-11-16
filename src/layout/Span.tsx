import type { DOMElement } from "ink";
import { createElement, type ReactNode, type Ref } from "react";

/**
 * Inline text that hands out its node, which Ink's `<Text>` does not, so it can be found on screen
 * with `getTextBounds` — a link or a button inside a paragraph. Rendered the way Ink renders a
 * `<Transform>`: a bare text element, which inside a `<Text>` is inline.
 */
export function Span({ ref, children }: { ref?: Ref<DOMElement>; children?: ReactNode }) {
  return createElement("ink-text", { ref }, children);
}
