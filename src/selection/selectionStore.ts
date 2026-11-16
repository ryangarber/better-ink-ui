import { createStore } from "../shared/store.ts";

/** Whatever holds the selection, and how to let it go. */
interface SelectionHolder {
  id: string;
  clear: () => void;
}

/**
 * The one selection keys go to, as a terminal has only the one: Ctrl+C copies from it rather than
 * quitting, and Shift and the arrows stretch it wherever the focus is.
 */
const store = createStore<SelectionHolder | null>(null);

export const SelectionStore = {
  holder: () => store.get(),
  subscribe: store.subscribe,
  /** Takes the selection over, clearing whichever other held it. */
  hold: (holder: SelectionHolder) => {
    const previous = store.get();
    store.set(holder);
    if (previous && previous.id !== holder.id) previous.clear();
  },
  /** Gives the selection up, if `id` still holds it, leaving it drawn. */
  release: (id: string) => {
    if (store.get()?.id === id) store.set(null);
  },
  /** Clears the selection held, unless `id` holds it. */
  clear: (id?: string) => {
    const holder = store.get();
    if (!holder || holder.id === id) return;
    store.set(null);
    holder.clear();
  }
} as const;
