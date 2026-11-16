import { type Ref, type RefCallback, useMemo, useRef } from "react";

type PossibleRef<T> = Ref<T> | undefined;

const assign = <T>(ref: PossibleRef<T>, value: T | null) => {
  if (typeof ref === "function") return ref(value);
  if (ref && typeof ref === "object") (ref as { current: T | null }).current = value;
};

const merge =
  <T>(refs: PossibleRef<T>[]): RefCallback<T> =>
  (node) => {
    const cleanups = refs.map((ref) => assign(ref, node));
    return () => {
      refs.forEach((ref, index) => {
        const cleanup = cleanups[index];
        if (typeof cleanup === "function") cleanup();
        else assign(ref, null);
      });
    };
  };

/**
 * One ref callback that sets every ref given. It changes only when one of the refs does, so React
 * does not detach and re-attach the node on every render just because the rest array is new.
 */
export const useMergedRef = <T>(...refs: PossibleRef<T>[]): RefCallback<T> => {
  const stable = useRef(refs);
  const previous = stable.current;
  if (previous.length !== refs.length || previous.some((ref, index) => ref !== refs[index]))
    stable.current = refs;
  const current = stable.current;
  return useMemo(() => merge(current), [current]);
};
