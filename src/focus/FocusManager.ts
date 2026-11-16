import type { DOMElement } from "ink";
import { compareDrawOrder } from "../input/geometry.ts";
import { currentPress } from "../input/press.ts";

/** A part of the tree focus can be confined to: a dialog, a page drawn over the rest. */
export interface FocusScopeHandle {
  parent: FocusScopeHandle | null;
  /** Every target ever registered inside it, which a focus is restored from on its way out. */
  ids: Set<string>;
}

export interface FocusTargetOptions {
  /** How the target is focused by name. @default a unique id */
  id?: string;
  /** Neither focusable nor reached with Tab, and gives up the focus while it has it. */
  disabled?: boolean;
  /**
   * Whether Tab reaches it. A target that is not a tab stop is only focused by name or by a press
   * — a page opened over the app, say. @default true
   */
  tabStop?: boolean;
  /**
   * Its place in the Tab order, lowest first. Targets of the same order go in the order they are
   * drawn in, where their node is known, and otherwise the order they were mounted in. @default 0
   */
  order?: number;
  /**
   * Takes the focus whenever the target that had it goes away — closes, unmounts, is disabled —
   * and nothing else asked for it: the main input of an app. Of several, the highest wins.
   * `true` is `1`.
   */
  sink?: boolean | number;
  /** Takes the focus as it mounts. */
  autoFocus?: boolean;
  /**
   * Sees Tab and Shift+Tab while it has the focus, before they move it, and keeps them by
   * returning `true` — to indent, or to accept a completion.
   */
  onTab?: (direction: 1 | -1) => boolean | undefined | void;
}

interface Target {
  id: string;
  disabled: boolean;
  tabStop: boolean;
  order: number;
  sink: number;
  sequence: number;
  scope: FocusScopeHandle | null;
  node: () => DOMElement | null;
  onTab?: FocusTargetOptions["onTab"];
}

const isWithin = (scope: FocusScopeHandle | null, ancestor: FocusScopeHandle) => {
  for (let current = scope; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
};

/**
 * Where the keys go: one target at a time, out of those registered. The focus asked for is kept
 * even while its target is gone, so a panel that only moved — unmounted in one place, mounted in
 * another — has it back, and in the meantime the focus falls to the best sink.
 */
export class FocusManager {
  private targets = new Map<string, Target>();
  private requested: string | null = null;
  private traps: FocusScopeHandle[] = [];
  private sequence = 0;
  private listeners = new Set<() => void>();
  /**
   * The last press the focus was asked for during, by a target pressed or by any handler of it: the
   * first ask a press makes is the one it keeps.
   */
  private press: object | null = null;
  private cached: { version: number; focused: string | null } | null = null;
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Every change is announced; hooks re-render only where what they read of it changed. */
  private changed() {
    this.version++;
    this.cached = null;
    for (const listener of [...this.listeners]) listener();
  }

  /** The innermost trap, which Tab and the sinks are confined to. */
  private trap() {
    return this.traps.at(-1) ?? null;
  }

  private isEligible(target: Target | undefined): target is Target {
    if (!target || target.disabled) return false;
    const trap = this.trap();
    return !trap || isWithin(target.scope, trap);
  }

  /** Targets in Tab order. */
  private ordered(filter: (target: Target) => boolean) {
    return [...this.targets.values()].filter(filter).sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      const nodeA = a.node();
      const nodeB = b.node();
      if (nodeA && nodeB && nodeA !== nodeB) {
        const order = compareDrawOrder(nodeA, nodeB);
        if (order) return order;
      }
      return a.sequence - b.sequence;
    });
  }

  /** The id of the target with the focus, or null. */
  focused = (): string | null => {
    if (this.cached?.version === this.version) return this.cached.focused;
    let focused: string | null = null;
    const requested = this.requested === null ? undefined : this.targets.get(this.requested);
    if (this.isEligible(requested)) focused = requested.id;
    else {
      let best: Target | undefined;
      for (const target of this.targets.values()) {
        if (!target.sink || !this.isEligible(target)) continue;
        if (!best || target.sink > best.sink) best = target;
      }
      // A trap with no sink of its own keeps the focus on its first tab stop.
      if (!best && this.trap())
        best = this.ordered((target) => this.isEligible(target) && target.tabStop)[0];
      focused = best?.id ?? null;
    }
    this.cached = { version: this.version, focused };
    return focused;
  };

  /** Whether a target with this id is mounted. */
  has = (id: string) => this.targets.has(id);

  /** The focus as asked for, which may name a target not mounted at the moment. */
  requestedId = () => this.requested;

  /**
   * Asks for the focus on a target, by id. Unmounted, it gets the focus once it mounts. While a
   * trap holds the focus, a target mounted outside of it is not given it.
   */
  focus = (id: string | null) => {
    const trap = this.trap();
    const target = id === null ? undefined : this.targets.get(id);
    if (trap && target && !isWithin(target.scope, trap)) return;
    this.press = currentPress() ?? this.press;
    if (this.requested === id) return;
    this.requested = id;
    this.changed();
  };

  /** Lets the focus go, to the best sink. */
  blur = () => this.focus(null);

  /** Moves the focus to the next tab stop (or previous, with -1), wrapping around. */
  cycle = (direction: 1 | -1 = 1) => {
    const stops = this.ordered((target) => this.isEligible(target) && target.tabStop);
    if (!stops.length) return;
    const index = stops.findIndex((target) => target.id === this.focused());
    const next =
      index < 0
        ? direction === 1
          ? 0
          : stops.length - 1
        : (index + direction + stops.length) % stops.length;
    this.focus(stops[next]?.id ?? null);
  };

  focusNext = () => this.cycle(1);
  focusPrevious = () => this.cycle(-1);

  /** Hands Tab to the focused target, returning whether it kept it. */
  handleTab = (direction: 1 | -1) => {
    const focused = this.focused();
    const target = focused === null ? undefined : this.targets.get(focused);
    if (target?.onTab?.(direction) === true) return true;
    this.cycle(direction);
    return false;
  };

  /**
   * @internal Focuses a target on a press, unless the press already moved the focus: a target
   * inside it took it, or a button inside it opened something that did.
   */
  focusOnPress = (id: string, press: object) => {
    if (this.press === press) return;
    this.focus(id);
  };

  /** @internal */
  register = (
    id: string,
    options: Omit<FocusTargetOptions, "id" | "autoFocus">,
    scope: FocusScopeHandle | null,
    node: () => DOMElement | null
  ) => {
    const target: Target = {
      id,
      disabled: !!options.disabled,
      tabStop: options.tabStop ?? true,
      order: options.order ?? 0,
      sink: options.sink === true ? 1 : options.sink || 0,
      sequence: this.sequence++,
      scope,
      node,
      onTab: options.onTab
    };
    this.targets.set(id, target);
    for (let current = scope; current; current = current.parent) current.ids.add(id);
    this.changed();
    return () => {
      if (this.targets.get(id) !== target) return;
      this.targets.delete(id);
      this.changed();
    };
  };

  /** @internal Updates a target's options without moving its place in the order. */
  update = (id: string, options: Omit<FocusTargetOptions, "id" | "autoFocus">) => {
    const target = this.targets.get(id);
    if (!target) return;
    const next = {
      disabled: !!options.disabled,
      tabStop: options.tabStop ?? true,
      order: options.order ?? 0,
      sink: options.sink === true ? 1 : options.sink || 0
    };
    target.onTab = options.onTab;
    if (
      target.disabled === next.disabled &&
      target.tabStop === next.tabStop &&
      target.order === next.order &&
      target.sink === next.sink
    )
      return;
    Object.assign(target, next);
    this.changed();
  };

  /** @internal Confines Tab and the sinks to a scope until the returned function is called. */
  trapFocus = (scope: FocusScopeHandle) => {
    this.traps.push(scope);
    this.changed();
    return () => {
      const index = this.traps.lastIndexOf(scope);
      if (index >= 0) this.traps.splice(index, 1);
      this.changed();
    };
  };

  /** The first tab stop inside a scope, if any. */
  firstIn = (scope: FocusScopeHandle) =>
    this.ordered((target) => !target.disabled && target.tabStop && isWithin(target.scope, scope))[0]
      ?.id ?? null;
}
