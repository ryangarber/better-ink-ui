import { type DOMElement, useInput } from "ink";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { useMouseInput } from "../input/useMouseInput.ts";
import { Box, type BoxProps } from "../layout/Box.tsx";
import { useMergedRef } from "../shared/useMergedRef.ts";
import { FocusManager, type FocusScopeHandle, type FocusTargetOptions } from "./FocusManager.ts";

/** The manager focus hooks use outside of any `FocusProvider`. */
export const defaultFocusManager = new FocusManager();

const FocusManagerContext = createContext<FocusManager>(defaultFocusManager);
const FocusScopeContext = createContext<FocusScopeHandle | null>(null);

/** What a focus target hands down: its id, and whether it has the focus. */
export interface FocusState {
  id: string | null;
  isFocused: boolean;
}

/** Outside of any target — a page with the keys to itself — the focus is always "here". */
const FocusContext = createContext<FocusState>({ id: null, isFocused: true });

/**
 * Whether the nearest `FocusTarget` around this has the focus, for what it draws: a list that
 * takes the arrows only while its panel is focused. Outside of any target, it always has.
 */
export const useFocusContext = () => useContext(FocusContext);

/**
 * Gives everything inside a focus manager, and moves the focus between tab stops on Tab and
 * Shift+Tab (unless `tabKeys` is false, for an app handling them itself — through `cycle`).
 */
export function FocusProvider({
  manager: given,
  tabKeys = true,
  children
}: {
  manager?: FocusManager;
  tabKeys?: boolean;
  children?: ReactNode;
}) {
  const [own] = useState(() => new FocusManager());
  const manager = given ?? own;
  useInput(
    (_input, key) => {
      if (!key.tab || key.ctrl || key.meta) return;
      manager.handleTab(key.shift ? -1 : 1);
    },
    { isActive: tabKeys }
  );
  return <FocusManagerContext value={manager}>{children}</FocusManagerContext>;
}

/** The focus manager, and which target has the focus. */
export const useFocusManager = () => {
  const manager = useContext(FocusManagerContext);
  const focused = useSyncExternalStore(manager.subscribe, manager.focused, manager.focused);
  return {
    manager,
    /** The id of the target with the focus, or null. */
    focused,
    focus: manager.focus,
    blur: manager.blur,
    focusNext: manager.focusNext,
    focusPrevious: manager.focusPrevious,
    cycle: manager.cycle
  };
};

/** Whether the target with an id has the focus, for something drawn outside of it. */
export const useIsFocused = (id: string) => {
  const manager = useContext(FocusManagerContext);
  const get = () => manager.focused() === id;
  return useSyncExternalStore(manager.subscribe, get, get);
};

/**
 * Makes a component something the focus can be on. Attach `ref` to its outermost element so it
 * takes its place in the Tab order from where it is drawn.
 */
export const useFocusTarget = ({
  id: ownId,
  autoFocus = false,
  ...options
}: FocusTargetOptions = {}) => {
  const manager = useContext(FocusManagerContext);
  const scope = useContext(FocusScopeContext);
  const generated = useId();
  const id = ownId ?? generated;
  const nodeRef = useRef<DOMElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useLayoutEffect(
    () => manager.register(id, optionsRef.current, scope, () => nodeRef.current),
    [manager, id, scope]
  );
  useLayoutEffect(() => {
    manager.update(id, options);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: focused once, as it mounts
  useEffect(() => {
    if (autoFocus) manager.focus(id);
  }, []);

  const isFocused = useIsFocused(id);
  const focus = useCallback(() => manager.focus(id), [manager, id]);
  const ref = useCallback((node: DOMElement | null) => {
    nodeRef.current = node;
  }, []);
  return { id, isFocused, focus, ref };
};

export interface FocusTargetProps extends FocusTargetOptions, Omit<BoxProps, "id"> {
  /** Takes the focus on a press anywhere inside it — unless a target inside took it. @default true */
  focusOnClick?: boolean;
}

/**
 * A box the focus can be on: a panel, a field, a list. It takes the focus when pressed, and
 * what it draws reads whether it has it through `useFocusContext`.
 */
export function FocusTarget({
  id,
  disabled,
  tabStop,
  order,
  sink,
  autoFocus,
  onTab,
  focusOnClick = true,
  ref,
  children,
  ...props
}: FocusTargetProps) {
  const target = useFocusTarget({ id, disabled, tabStop, order, sink, autoFocus, onTab });
  const manager = useContext(FocusManagerContext);
  const { mouseRef } = useMouseInput({
    onClick: ({ nativeEvent }) => manager.focusOnPress(target.id, nativeEvent),
    isActive: focusOnClick && !disabled
  });
  const mergedRef = useMergedRef(target.ref, mouseRef, ref);
  const value = useMemo(
    () => ({ id: target.id, isFocused: target.isFocused }),
    [target.id, target.isFocused]
  );
  return (
    <FocusContext value={value}>
      <Box ref={mergedRef} flexDirection="column" {...props}>
        {children}
      </Box>
    </FocusContext>
  );
}

/**
 * A part of the app the focus can be held in. With `trap`, Tab only cycles the targets inside it,
 * and the focus stays inside while it is mounted — a dialog, a page drawn over the rest. With
 * `autoFocus`, its first tab stop takes the focus as it mounts; with `restoreFocus`, the focus goes
 * back to where it was once it unmounts, if it was still inside.
 */
export function FocusScope({
  trap = false,
  autoFocus = false,
  restoreFocus = false,
  children
}: {
  trap?: boolean;
  autoFocus?: boolean;
  restoreFocus?: boolean;
  children?: ReactNode;
}) {
  const manager = useContext(FocusManagerContext);
  const parent = useContext(FocusScopeContext);
  const [scope] = useState<FocusScopeHandle>(() => ({ parent, ids: new Set() }));

  useLayoutEffect(() => {
    if (trap) return manager.trapFocus(scope);
  }, [manager, scope, trap]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount and unmount only
  useEffect(() => {
    const previous = manager.requestedId();
    if (autoFocus) {
      const first = manager.firstIn(scope);
      if (first !== null) manager.focus(first);
    }
    return () => {
      const current = manager.requestedId();
      if (restoreFocus && (current === null || scope.ids.has(current))) manager.focus(previous);
    };
  }, []);

  return <FocusScopeContext value={scope}>{children}</FocusScopeContext>;
}
