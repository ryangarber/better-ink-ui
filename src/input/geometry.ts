import { type DOMElement, measureElement } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { Bounds, Point } from "./mouse.ts";

type DOMNode = DOMElement["childNodes"][number];

/**
 * Bounds measured while one mouse event is dispatched. Layout cannot change in the middle of a
 * dispatch — React commits after it — so every handler measuring the same nodes (each ancestor
 * clipping a hundred rows, say) shares one measurement instead of walking the tree again.
 */
let cache: Map<DOMElement, Bounds | null> | null = null;
let rootTops: Map<DOMElement, number> | null = null;

/** Runs `fn` with measurements shared across every call inside it. */
export const withMeasureCache = <T>(fn: () => T): T => {
  if (cache) return fn();
  cache = new Map();
  rootTops = new Map();
  try {
    return fn();
  } finally {
    cache = null;
    rootTops = null;
  }
};

const rootOf = (node: DOMElement) => {
  let root = node;
  while (root.parentNode) root = root.parentNode;
  return root;
};

/**
 * Where an element sits on screen, in the coordinates mouse reports use.
 *
 * `measureElement` positions a node inside Ink's output, which is drawn at the bottom of the
 * terminal (or fills it), so its top row is however far it falls short of filling the screen.
 */
export const getBounds = (node: DOMElement, rows: number): Bounds => {
  const cached = cache?.get(node);
  if (cached) return cached;
  const { x, y, width, height } = measureElement(node);
  const root = rootOf(node);
  let top = rootTops?.get(root);
  if (top === undefined) {
    top = rows - (root.yogaNode?.getComputedHeight() ?? rows);
    rootTops?.set(root, top);
  }
  const bounds = { x, y: y + top, width, height };
  cache?.set(node, bounds);
  return bounds;
};

const clips = (node: DOMElement) => {
  const { overflow, overflowX, overflowY } = node.style;
  return {
    x: (overflowX ?? overflow) === "hidden",
    y: (overflowY ?? overflow) === "hidden"
  };
};

/**
 * What can be seen of an element: its bounds cut to every view clipping it, or null where none of
 * it is drawn. Rows scrolled out of a view are still laid out past its edges, so only these should
 * take the mouse.
 */
export const getVisibleBounds = (node: DOMElement, rows: number): Bounds | null => {
  const visible = getBounds(node, rows);
  let { x, y, width, height } = visible;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    const clip = clips(parent);
    if (!clip.x && !clip.y) continue;
    const box = getBounds(parent, rows);
    if (clip.x) {
      const right = Math.min(x + width, box.x + box.width);
      x = Math.max(x, box.x);
      width = right - x;
    }
    if (clip.y) {
      const bottom = Math.min(y + height, box.y + box.height);
      y = Math.max(y, box.y);
      height = bottom - y;
    }
    if (width <= 0 || height <= 0) return null;
  }
  return { x, y, width, height };
};

export const contains = (bounds: Bounds, point: Point) =>
  point.x >= bounds.x &&
  point.x < bounds.x + bounds.width &&
  point.y >= bounds.y &&
  point.y < bounds.y + bounds.height;

/** The text a node shows, before Ink styles it. */
const textOf = (node: DOMNode): string =>
  node.nodeName === "#text" ? node.nodeValue : node.childNodes.map(textOf).join("");

/** The text before `target` inside `node`, or null if it is not there. */
const textBefore = (node: DOMElement, target: DOMElement): string | null => {
  let text = "";
  for (const child of node.childNodes) {
    if (child === target) return text;
    if (child.nodeName !== "#text") {
      const before = textBefore(child, target);
      if (before !== null) return text + before;
    }
    text += textOf(child);
  }
  return null;
};

/**
 * Where the character at `index` of `text` lands once wrapped into `wrapped`. Wrapping only adds
 * line breaks, and at most drops the spaces it breaks on, so the two are walked side by side.
 */
const locate = (text: string, wrapped: string, index: number) => {
  let line = 0;
  let lineStart = 0;
  let j = 0;
  for (let i = 0; i < index && j < wrapped.length; ) {
    if (text[i] === wrapped[j]) {
      if (wrapped[j] === "\n") {
        line++;
        lineStart = j + 1;
      }
      i++;
      j++;
    } else if (wrapped[j] === "\n") {
      j++;
      line++;
      lineStart = j;
    } else if (text[i] === " ") i++;
    else return null;
  }
  if (wrapped[j] === "\n") {
    j++;
    line++;
    lineStart = j;
  }
  return { line, column: stringWidth(wrapped.slice(lineStart, j)) };
};

/**
 * Where an inline run of text — a `<Span>` inside a `<Text>` — sits on screen, or null where it
 * cannot be seen. Inline text has no layout of its own, so the block it is in is wrapped the way
 * Ink wraps it to find the run. Only the run's first character is placed, and the run is taken to
 * fit on one line, which holds for the short labels and links this is meant for.
 */
export const getTextBounds = (node: DOMElement, rows: number): Bounds | null => {
  let block = node.parentNode;
  while (block && block.nodeName !== "ink-text") block = block.parentNode;
  if (!block?.yogaNode) return null;

  const textWrap = block.style.textWrap ?? "wrap";
  if (textWrap !== "wrap" && textWrap !== "hard") return null;

  const before = textBefore(block, node);
  if (before === null) return null;

  const text = textOf(block);
  const bounds = getBounds(block, rows);
  const fits = text.split("\n").every((line) => stringWidth(line) <= bounds.width);
  const wrapped = fits
    ? text
    : wrapAnsi(text, bounds.width, { trim: false, hard: true, wordWrap: textWrap === "wrap" });

  const position = locate(text, wrapped, before.length);
  if (!position) return null;

  const result = {
    x: bounds.x + position.column,
    y: bounds.y + position.line,
    width: stringWidth(textOf(node)),
    height: 1
  };
  for (let parent = block.parentNode; parent; parent = parent.parentNode) {
    const clip = clips(parent);
    if (!clip.x && !clip.y) continue;
    const box = getBounds(parent, rows);
    if (!contains(box, result) || !contains(box, { x: result.x + result.width - 1, y: result.y }))
      return null;
  }
  return result;
};

/** Overlays drawn over the rest, each taking the mouse wherever it is drawn. */
const layers: DOMElement[] = [];

/** Child indices from the root down to `node`. */
const pathOf = (node: DOMElement) => {
  const indices: number[] = [];
  for (let child = node; child.parentNode; child = child.parentNode)
    indices.unshift(child.parentNode.childNodes.indexOf(child));
  return indices;
};

/**
 * Orders nodes as Ink draws them: a later sibling over an earlier one, and a child over its
 * parent. Sorting by it puts the topmost last.
 */
export const compareDrawOrder = (a: DOMElement, b: DOMElement) => {
  const pathA = pathOf(a);
  const pathB = pathOf(b);
  for (let i = 0; i < Math.min(pathA.length, pathB.length); i++) {
    const difference = (pathA[i] ?? 0) - (pathB[i] ?? 0);
    if (difference) return difference;
  }
  return pathA.length - pathB.length;
};

const isInside = (node: DOMElement, ancestor: DOMElement) => {
  for (let parent: DOMElement | undefined = node; parent; parent = parent.parentNode)
    if (parent === ancestor) return true;
  return false;
};

/**
 * Makes `node` an overlay until the returned function is called: where it is drawn, only what is
 * inside it takes the mouse, rather than whatever it covers.
 */
export const addMouseLayer = (node: DOMElement) => {
  layers.push(node);
  return () => {
    const index = layers.indexOf(node);
    if (index >= 0) layers.splice(index, 1);
  };
};

/**
 * Whether an overlay is drawn over `node` at `point`, hiding it from the mouse there. With
 * `ownLayers`, an overlay inside `node` — a scroll view's own scrollbar — counts as part of it.
 */
export const isCovered = (node: DOMElement, point: Point, rows: number, ownLayers = false) => {
  let top: DOMElement | undefined;
  for (const layer of layers) {
    const bounds = getVisibleBounds(layer, rows);
    if (!bounds || !contains(bounds, point)) continue;
    if (!top || compareDrawOrder(layer, top) > 0) top = layer;
  }
  if (!top || isInside(node, top)) return false;
  return !(ownLayers && isInside(top, node));
};
