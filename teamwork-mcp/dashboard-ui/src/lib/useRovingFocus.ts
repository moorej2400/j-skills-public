import { useCallback, useEffect, useRef, useState } from "react";

// Roving-tabindex helper for j/k (and arrow-key) navigation over a vertical
// list. The hook returns:
//   - `focusedIndex` — which item should currently have `tabIndex={0}`; the
//     others should set `tabIndex={-1}` so Tab leaves the list cleanly.
//   - `getItemProps(index)` — spread onto each item to wire tabIndex, the
//     `onFocus` handler that keeps `focusedIndex` in sync with mouse focus,
//     and a ref slot for programmatic focus.
//   - `containerRef` — attach to the list wrapper. The hook only listens for
//     keys when `enabled` is true and focus is somewhere inside this
//     container (or on the document body — the dashboard's grid never has an
//     explicit focus when first rendered). Keys are also skipped if the
//     active element is an input/textarea/contenteditable.
//
// `onActivate(index)` fires for Enter on the focused item.

type Options = {
  count: number;
  enabled?: boolean;
  onActivate?: (index: number) => void;
};

export function useRovingFocus({ count, enabled = true, onActivate }: Options) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Clamp focus when the list shrinks.
  useEffect(() => {
    if (count === 0) {
      setFocusedIndex(0);
      return;
    }
    if (focusedIndex >= count) setFocusedIndex(count - 1);
  }, [count, focusedIndex]);

  const focusIndex = useCallback((next: number) => {
    setFocusedIndex(next);
    const el = itemRefs.current[next];
    if (el) el.focus();
  }, []);

  useEffect(() => {
    if (!enabled || count === 0) return;
    const onKey = (ev: KeyboardEvent) => {
      const ae = document.activeElement;
      const tag = ae?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (ae as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      // Only respond if focus is inside the container or nowhere meaningful.
      const container = containerRef.current;
      if (container && ae && ae !== document.body && !container.contains(ae)) {
        return;
      }
      if (ev.key === "j" || ev.key === "ArrowDown") {
        ev.preventDefault();
        focusIndex(Math.min(count - 1, focusedIndex + 1));
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        ev.preventDefault();
        focusIndex(Math.max(0, focusedIndex - 1));
      } else if (ev.key === "Enter") {
        // Only fire when the focused item itself is the active element. If a
        // nested button/link inside the item has focus, let the native
        // activation handle it instead of double-firing.
        const focusedEl = itemRefs.current[focusedIndex];
        if (focusedEl && ae === focusedEl) {
          ev.preventDefault();
          onActivate?.(focusedIndex);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count, enabled, focusIndex, focusedIndex, onActivate]);

  const getItemProps = useCallback(
    (index: number) => ({
      tabIndex: index === focusedIndex ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        itemRefs.current[index] = el;
      },
      onFocus: () => setFocusedIndex(index),
    }),
    [focusedIndex],
  );

  return { focusedIndex, getItemProps, containerRef, focusIndex };
}
