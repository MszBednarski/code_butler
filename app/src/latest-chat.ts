import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// The reversed scroll container starts at its native bottom (scrollTop = 0).
// Only preserve a reader's position when content changes; never animate opening.
export function useLatestChat(
  ref: RefObject<HTMLDivElement | null>,
  key: string,
  prepend: number,
  force: RefObject<boolean>,
) {
  const previous = useRef<{
    element: HTMLDivElement;
    key: string;
    height: number;
    top: number;
    prepend: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !element.clientHeight) return;
    const saved = previous.current;
    if (saved?.element === element && saved.key === key) {
      const delta = element.scrollHeight - saved.height;
      if (force.current) element.scrollTop = 0;
      else if (prepend !== saved.prepend) element.scrollTop = saved.top;
      else if (delta)
        element.scrollTop = Math.abs(saved.top) < 100 ? 0 : saved.top - delta;
      else if (Math.abs(element.scrollTop - saved.top) > 1)
        element.scrollTop = saved.top;
    }
    force.current = false;
    previous.current = {
      element,
      key,
      height: element.scrollHeight,
      top: element.scrollTop,
      prepend,
    };
  });
  return () => {
    const element = ref.current;
    if (element?.clientHeight)
      previous.current = {
        element,
        key,
        height: element.scrollHeight,
        top: element.scrollTop,
        prepend,
      };
  };
}
export function mergeHistory<T extends { id: string; createdAt?: number }>(
  old: T[],
  fresh: T[],
): T[] {
  const messages = new Map(old.map((m) => [m.id, m]));
  for (const item of fresh) messages.set(item.id, item);
  return [...messages.values()].sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  );
}
