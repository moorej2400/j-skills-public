import { useSyncExternalStore } from "react";

// One global 1Hz tick singleton. Components that render relative-time labels
// can subscribe via `useNow()`; only those subscribers re-render each second,
// rather than the whole subtree (which is what happens when `nowMs` is passed
// down as a prop and the parent re-renders).

type Listener = () => void;
const listeners = new Set<Listener>();
let interval: ReturnType<typeof setInterval> | null = null;
let current = Date.now();

function ensureRunning(): void {
  if (interval !== null) return;
  interval = setInterval(() => {
    current = Date.now();
    for (const l of listeners) l();
  }, 1000);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  ensureRunning();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

function getSnapshot(): number {
  return current;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
