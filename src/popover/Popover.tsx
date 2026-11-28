import { type DOMElement, Box as InkBox, measureElement, useStdout } from "ink";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  contains,
  getBounds,
  getTextBounds,
  getVisibleBounds,
  isCovered
} from "../input/geometry.ts";
import type { Bounds, Point } from "../input/mouse.ts";
import { useMouse } from "../input/useMouse.ts";
import { useMouseLayer } from "../input/useMouseInput.ts";
import { Box, type BoxProps } from "../layout/Box.tsx";
import { Span } from "../layout/Span.tsx";
import { InsideTextContext } from "../layout/Text.tsx";
import { createStore } from "../shared/store.ts";
import { useMergedRef } from "../shared/useMergedRef.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { type PopoverAlign, type PopoverPosition, placePopover } from "./placement.ts";

export interface PopoverState {
  /** Whether the popover is shown. */
  isOpen: boolean;
  /** Whether the pointer is over the trigger, or over the popover it opened. */
  isHovered: boolean;
  /** Whether a click on the trigger is holding the popover open. */
  isPinned: boolean;
}

export interface PopoverControls {
  /** Closes the popover, as a click outside it would. */
  close: () => void;
}

export interface PopoverProps extends Omit<BoxProps, "children" | "position"> {
  /**
   * What the popover shows. A function is only called while it is open, so content that costs
   * something to build costs nothing until then.
   */
  content: ReactNode | ((controls: PopoverControls) => ReactNode);
  /** The trigger. Children may be `({ isOpen, isHovered, isPinned }) => …`. */
  children?: ReactNode | ((state: PopoverState) => ReactNode);
  /** The side of the trigger it prefers to open on, flipping where the other has more room. */
  position?: PopoverPosition;
  /** Where along that side it lines up. */
  align?: PopoverAlign;
  /** Cells between the trigger and the popover. */
  offset?: number;
  /**
   * Where the popover must stay: screen bounds, or an element's. Defaults to the area the nearest
   * {@link PopoverProvider} draws over.
   */
  bounds?: Bounds | RefObject<DOMElement | null>;
  /** Placed beside this element rather than the trigger, which still takes the mouse. */
  anchor?: RefObject<DOMElement | null>;
  /** Opens while the pointer is over the trigger or the popover. */
  openOnHover?: boolean;
  /** A click on the trigger holds the popover open, and the next one lets it go. */
  toggleOnClick?: boolean;
  /** A press anywhere but the trigger and the popover closes it. */
  closeOnClickOutside?: boolean;
  /** Shows the popover whatever the mouse does. Interactions are reported to `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Never opens, and stops listening to the mouse. */
  disabled?: boolean;
  /**
   * The popover's own box. It is drawn in the theme's `popover` background and `popoverBorder`
   * border, where the theme has them, with a border and a column of padding either side.
   */
  contentProps?: BoxProps;
}

interface PopoverEntry {
  id: string;
  /** The popover whose content this one's trigger is in. */
  parent: string | undefined;
  content: ReactNode;
  getAnchor: () => Bounds | null;
  position: PopoverPosition;
  align: PopoverAlign;
  offset: number;
  bounds: PopoverProps["bounds"];
  box: BoxProps | undefined;
}

const createPopoverStore = () => {
  const entries = createStore<readonly PopoverEntry[]>([]);
  /** Each open popover's box, as drawn. */
  const nodes = new Map<string, DOMElement>();
  const closers = new Map<string, () => void>();

  const parentOf = (id: string) => entries.get().find((entry) => entry.id === id)?.parent;
  const isWithin = (id: string, ancestor: string) => {
    for (let at: string | undefined = id; at; at = parentOf(at)) if (at === ancestor) return true;
    return false;
  };

  return {
    entries,
    nodes,
    show: (entry: PopoverEntry) =>
      entries.set((list) => {
        const index = list.findIndex((item) => item.id === entry.id);
        if (index < 0) return [...list, entry];
        const next = [...list];
        next[index] = entry;
        return next;
      }),
    hide: (id: string) => entries.set((list) => list.filter((entry) => entry.id !== id)),
    /** Whether `point` is over the popover, or one opened from inside it. */
    isInside: (id: string, point: Point, rows: number) => {
      for (const [other, node] of nodes) {
        if (!isWithin(other, id)) continue;
        const bounds = getVisibleBounds(node, rows);
        if (bounds && contains(bounds, point)) return true;
      }
      return false;
    },
    onClose: (id: string, close: () => void) => {
      closers.set(id, close);
      return () => {
        if (closers.get(id) === close) closers.delete(id);
      };
    },
    /** Closes every other popover, but those it was opened from: one is shown at a time. */
    opened: (id: string) => {
      for (const [other, close] of [...closers]) if (!isWithin(id, other)) close();
    }
  };
};

type PopoverStore = ReturnType<typeof createPopoverStore>;

const PopoverContext = createContext<PopoverStore | null>(null);
const PopoverParentContext = createContext<string | undefined>(undefined);

type LayoutRoot = DOMElement & { internal_layoutListeners?: Set<() => void> };

/**
 * Calls `listener` after every layout Ink computes — however little of the tree rendered — and
 * on resizes. Ink keeps these on its root node, which it offers no hook to reach from outside.
 */
const onLayout = (node: DOMElement, listener: () => void) => {
  let root = node as LayoutRoot;
  while (root.parentNode) root = root.parentNode as LayoutRoot;
  if (root.nodeName !== "ink-root") return () => {};
  root.internal_layoutListeners ??= new Set();
  const listeners = root.internal_layoutListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

interface Placement {
  top: number;
  left: number;
  maxWidth: number;
}

const resolveBounds = (bounds: PopoverEntry["bounds"], rows: number) => {
  if (!bounds || !("current" in bounds)) return bounds;
  return bounds.current ? getVisibleBounds(bounds.current, rows) : null;
};

/**
 * One open popover, drawn in the layer. It is first laid out out of sight, below the layer's
 * clip, and only placed once its size is known, so it never shows where it does not belong. It
 * is placed again after every layout, following its trigger as what is around it moves, and
 * hidden while its trigger cannot be seen.
 */
function PopoverBox({
  entry,
  store,
  layerRef
}: {
  entry: PopoverEntry;
  store: PopoverStore;
  layerRef: RefObject<DOMElement | null>;
}) {
  const ref = useRef<DOMElement>(null);
  const { stdout } = useStdout();
  const theme = useTheme();
  const [placement, setPlacement] = useState<Placement | null>(null);

  const latest = useRef({ entry, stdout });
  useLayoutEffect(() => {
    latest.current = { entry, stdout };
  });

  const update = useCallback(() => {
    const node = ref.current;
    const layer = layerRef.current;
    if (!node || !layer) return;
    const { entry, stdout } = latest.current;
    const rows = (stdout as NodeJS.WriteStream).rows ?? 24;
    const area = getBounds(layer, rows);
    const anchor = entry.getAnchor();
    const bounds = resolveBounds(entry.bounds, rows) ?? (entry.bounds ? null : area);
    if (!anchor || !bounds) {
      setPlacement(null);
      return;
    }
    const { width, height } = measureElement(node);
    const { x, y } = placePopover({
      anchor,
      size: { width, height },
      bounds,
      position: entry.position,
      align: entry.align,
      offset: entry.offset
    });
    const next = { top: y - area.y, left: x - area.x, maxWidth: bounds.width };
    setPlacement((previous) =>
      previous?.top === next.top &&
      previous.left === next.left &&
      previous.maxWidth === next.maxWidth
        ? previous
        : next
    );
  }, [layerRef]);

  // After its own renders, which may change its size, and after everyone else's, which may move
  // its trigger. Layout listeners run before React attaches refs, so they wait a tick.
  useLayoutEffect(update);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    return onLayout(layer, () => queueMicrotask(update));
  }, [layerRef, update]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    store.nodes.set(entry.id, node);
    return () => {
      if (store.nodes.get(entry.id) === node) store.nodes.delete(entry.id);
    };
  }, [store, entry.id]);
  useMouseLayer(ref, !!placement);

  const { maxWidth, ...box } = entry.box ?? {};
  const placedMaxWidth =
    placement && typeof maxWidth === "number"
      ? Math.min(maxWidth, placement.maxWidth)
      : (placement?.maxWidth ?? maxWidth);

  return (
    <Box
      ref={ref}
      position="absolute"
      flexDirection="column"
      backgroundColor={theme.colors.popover !== undefined ? "popover" : undefined}
      borderColor={theme.colors.popoverBorder !== undefined ? "popoverBorder" : undefined}
      border
      paddingX={1}
      {...box}
      top={placement ? placement.top : "100%"}
      left={placement ? placement.left : 0}
      maxWidth={placedMaxWidth}
    >
      <PopoverParentContext value={entry.id}>{entry.content}</PopoverParentContext>
    </Box>
  );
}

function PopoverLayer({ store }: { store: PopoverStore }) {
  const entries = useSyncExternalStore(store.entries.subscribe, store.entries.get);
  const ref = useRef<DOMElement>(null);
  // Ink's own box: this library's would paint the background inherited over everything beneath.
  return (
    <InkBox
      ref={ref}
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      overflow="hidden"
    >
      {entries.map((entry) => (
        <PopoverBox key={entry.id} entry={entry} store={store} layerRef={ref} />
      ))}
    </InkBox>
  );
}

/**
 * Where the popovers inside are drawn: over everything else in the box it is rendered in, which
 * should fill the screen. Ink has no portals, so a popover's content is rendered here rather than
 * where its trigger is, and takes its context from here: put the provider inside whatever context
 * the content needs.
 */
export function PopoverProvider({ children }: { children?: ReactNode }) {
  const [store] = useState(createPopoverStore);
  return (
    <PopoverContext value={store}>
      {children}
      <PopoverLayer store={store} />
    </PopoverContext>
  );
}

let warned = false;

/**
 * A trigger that opens a popover beside it: while hovered, held open by a click, and closed by a
 * click outside, each of which can be turned off, or controlled with `open`. It opens on the
 * `position` preferred, flipping to the other side where that has more room, and stays inside
 * `bounds`. Inside a `<Text>`, the trigger is inline text.
 *
 * Opening one popover closes any other, but those it is inside of. Popovers are drawn by the
 * nearest {@link PopoverProvider}.
 */
export function Popover({
  content,
  children,
  position = "bottom",
  align = "start",
  offset = 0,
  bounds,
  anchor,
  openOnHover = true,
  toggleOnClick = true,
  closeOnClickOutside = true,
  open,
  onOpenChange,
  disabled = false,
  contentProps,
  ref,
  ...props
}: PopoverProps) {
  const store = useContext(PopoverContext);
  const parent = useContext(PopoverParentContext);
  const insideText = useContext(InsideTextContext);
  const id = useId();
  const { stdout } = useStdout();
  const triggerRef = useRef<DOMElement>(null);
  const mergedRef = useMergedRef(triggerRef, ref);

  if (!store && !warned) {
    warned = true;
    console.warn(
      "[better-ink-ui] A <Popover> is drawn by a <PopoverProvider>, and none is above it."
    );
  }

  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const isHovered = !disabled && openOnHover && hovered;
  const isPinned = !disabled && pinned;
  const isOpenInside = isHovered || isPinned;
  const isOpen = !disabled && (open ?? isOpenInside);

  const latest = useRef({ insideText, anchor, stdout, onOpenChange });
  useLayoutEffect(() => {
    latest.current = { insideText, anchor, stdout, onOpenChange };
  });

  // Read through refs, so the anchor the layer measures is always the latest.
  const [measure] = useState(() => {
    const rows = () => (latest.current.stdout as NodeJS.WriteStream).rows ?? 24;
    const trigger = (rows: number) => {
      const node = triggerRef.current;
      if (!node) return null;
      return latest.current.insideText ? getTextBounds(node, rows) : getVisibleBounds(node, rows);
    };
    const anchor = () => {
      const node = latest.current.anchor?.current;
      return node ? getVisibleBounds(node, rows()) : trigger(rows());
    };
    return { rows, trigger, anchor };
  });

  const reported = useRef(isOpenInside);
  useEffect(() => {
    if (reported.current === isOpenInside) return;
    reported.current = isOpenInside;
    latest.current.onOpenChange?.(isOpenInside);
  }, [isOpenInside]);

  const close = useCallback(() => {
    setPinned(false);
    setHovered(false);
    // Nothing inside changes for a popover only held open from outside, so it is told here.
    if (!reported.current) latest.current.onOpenChange?.(false);
  }, []);

  useEffect(() => {
    if (!store || !isOpen) return;
    store.opened(id);
    return store.onClose(id, close);
  }, [store, isOpen, id, close]);

  useMouse(
    (event) => {
      if (event.type === "wheel") return;
      const rows = measure.rows();
      const node = triggerRef.current;
      const trigger = measure.trigger(rows);
      const overTrigger =
        !!node && !!trigger && contains(trigger, event) && !isCovered(node, event, rows);
      const overPopover = isOpen && !!store?.isInside(id, event, rows);

      if (event.type === "move" && event.button === "none") {
        if (openOnHover) setHovered(overTrigger || overPopover);
        return;
      }
      if (event.type !== "down") return;
      if (overTrigger) {
        if (toggleOnClick && event.button === "left") setPinned((held) => !held);
      } else if (!overPopover && closeOnClickOutside && isOpen) close();
    },
    {
      motion: !disabled && openOnHover,
      isActive: !disabled && (openOnHover || toggleOnClick || (closeOnClickOutside && isOpen))
    }
  );

  const shown = isOpen ? (typeof content === "function" ? content({ close }) : content) : null;
  useLayoutEffect(() => {
    if (!store || !isOpen) return;
    store.show({
      id,
      parent,
      content: shown,
      getAnchor: measure.anchor,
      position,
      align,
      offset,
      bounds,
      box: contentProps
    });
  });
  useLayoutEffect(() => {
    if (!store || !isOpen) return;
    return () => store.hide(id);
  }, [store, isOpen, id]);

  const state = { isOpen, isHovered, isPinned };
  const trigger = typeof children === "function" ? children(state) : children;
  if (insideText) return <Span ref={mergedRef}>{trigger}</Span>;
  return (
    <Box ref={mergedRef} flexShrink={0} {...props}>
      {trigger}
    </Box>
  );
}
