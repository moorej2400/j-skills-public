import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { BUS_EVENT_NAMES, type BusEvent, type BusEventName } from "./types";

// ---------------------------------------------------------------------------
// SSE health — shared singleton observable. The `useSseHealth()` hook returns
// the current connection state ("connected" | "reconnecting" | "disconnected")
// of the most-recently-active stream so the SessionHeader breadcrumb and the
// TopBar can render a tiny live dot. Toast notifications fire on transitions
// (debounced — connect/disconnect flapping during dev StrictMode shouldn't
// spam users). Initial state is "disconnected" until the first `onopen`.
// ---------------------------------------------------------------------------

export type SseHealth = "connected" | "reconnecting" | "disconnected";

type HealthListener = () => void;
let healthState: SseHealth = "disconnected";
const healthListeners = new Set<HealthListener>();
let healthFlapTimer: ReturnType<typeof setTimeout> | null = null;

function setHealth(next: SseHealth): void {
  if (healthState === next) return;
  const prev = healthState;
  healthState = next;
  for (const l of healthListeners) l();
  // Debounce toast firing so a flicker (disconnect → reconnect within 2s)
  // doesn't spawn a spurious "Lost live connection" notice.
  if (healthFlapTimer) clearTimeout(healthFlapTimer);
  healthFlapTimer = setTimeout(() => {
    if (prev === "connected" && healthState !== "connected") {
      toast.error("Lost live connection", { id: "sse-health" });
    } else if (prev !== "connected" && healthState === "connected") {
      toast.success("Reconnected", { id: "sse-health" });
    }
  }, 2000);
}

function subscribeHealth(listener: HealthListener): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

function getHealthSnapshot(): SseHealth {
  return healthState;
}

// React hook for the live SSE health state. Used by the TopBar and
// SessionHeader breadcrumb dot.
export function useSseHealth(): SseHealth {
  return useSyncExternalStore(subscribeHealth, getHealthSnapshot, getHealthSnapshot);
}

// Strongly-typed handler map: each key is a BusEventName, and the handler
// receives the discriminated arm of `BusEvent` matching that name. This
// removes the `payload: any` taint at the call site and makes server schema
// drift a compile error rather than silent UI breakage.
export type EventHandlers = {
  [K in BusEventName]?: (event: Extract<BusEvent, { topic: K }>) => void;
};

type Options = {
  // Backoff config — reconnects on transport error or close.
  initialDelayMs?: number;
  maxDelayMs?: number;
};

function openStream(url: string, handlers: EventHandlers, opts: Options): { close: () => void } {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let source: EventSource | null = null;
  const initial = opts.initialDelayMs ?? 750;
  const max = opts.maxDelayMs ?? 15_000;

  const connect = () => {
    if (stopped) return;
    source = new EventSource(url);

    // Always wire the full superset of bus event names. The bridge consults
    // the latest `handlers` map at dispatch time, so adding/removing handler
    // keys after first render still works without re-opening the source.
    // (C2 in the review.)
    for (const name of BUS_EVENT_NAMES) {
      source.addEventListener(name, (ev: MessageEvent) => {
        const handler = handlers[name];
        if (!handler) return;
        try {
          const parsed = ev.data ? JSON.parse(ev.data) : null;
          // EventSource natively tracks `lastEventId` (set from the SSE
          // `id:` field) and replays it on reconnect, so we don't need to
          // re-thread it manually — but stamp the parsed payload's id from
          // ev.lastEventId if the server omitted it from the body, so
          // downstream consumers always see a number.
          if (parsed && typeof parsed === "object" && parsed.id == null && ev.lastEventId) {
            const n = Number(ev.lastEventId);
            if (!Number.isNaN(n)) parsed.id = n;
          }
          // Cast is safe: the SSE event name guarantees which arm of the
          // discriminated union the payload conforms to. We round-trip
          // through `unknown` to satisfy TS that the looped `name`'s
          // generic-narrowing isn't required.
          (handler as (e: unknown) => void)(parsed);
        } catch (err) {
          // Bad JSON should never happen, but we log instead of throwing
          // because that would tear down the source.
          console.warn(`[sse:${name}] parse error`, err);
        }
      });
    }

    source.onopen = () => {
      attempt = 0;
      setHealth("connected");
    };
    source.onerror = () => {
      if (stopped) return;
      source?.close();
      source = null;
      attempt += 1;
      const delay = Math.min(max, initial * 2 ** Math.min(attempt, 6));
      setHealth("reconnecting");
      timer = setTimeout(connect, delay);
    };
  };

  connect();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.close();
      source = null;
      setHealth("disconnected");
    },
  };
}

// React StrictMode runs effects mount → cleanup → mount in dev. Without a
// guard, the first cleanup closes the EventSource and the second mount opens
// a fresh one — extra connection churn against the server's per-IP cap, and
// duplicate event delivery during the brief overlap. We defer the cleanup
// close via `queueMicrotask`; if a re-mount lands first, it cancels the
// deferred close and reuses the existing stream. (See review C3.)
function useGuardedStream(
  key: string | null | undefined,
  build: (latestHandlers: EventHandlers) => { close: () => void },
  handlers: EventHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  type Guard = { key: string; stream: { close: () => void } | null; pendingClose: boolean };
  const guardRef = useRef<Guard | null>(null);

  useEffect(() => {
    const k = key ?? "__global__";
    const cur = guardRef.current;
    if (cur && cur.key === k && cur.stream) {
      // Re-mount with the same key — cancel any deferred close from the
      // previous cleanup and reuse the live stream.
      cur.pendingClose = false;
    } else {
      if (cur?.stream) cur.stream.close();
      const stream = build(handlersRef.current);
      guardRef.current = { key: k, stream, pendingClose: false };
    }
    return () => {
      const g = guardRef.current;
      if (!g) return;
      g.pendingClose = true;
      // Defer; if a re-mount happens synchronously after (StrictMode dev
      // double-invoke), it will flip pendingClose back to false before we
      // get here.
      queueMicrotask(() => {
        const cur2 = guardRef.current;
        if (!cur2 || !cur2.pendingClose) return;
        cur2.stream?.close();
        guardRef.current = null;
      });
    };
    // We intentionally exclude `build` from deps: it's recreated each render
    // by the caller wrappers below, but always closes over the same URL for
    // a given key. The handlersRef pattern keeps handler updates live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useSessionStream(
  sessionId: string | null | undefined,
  handlers: EventHandlers,
): void {
  useGuardedStream(
    sessionId ?? null,
    (latest) => {
      if (!sessionId) return { close: () => {} };
      // Bridge dispatches by name into the *current* handlers ref, so adding
      // keys after first render takes effect without reconnecting.
      const bridge: EventHandlers = {};
      for (const name of BUS_EVENT_NAMES) {
        (bridge as Record<string, (e: unknown) => void>)[name] = (e) => {
          const h = (latest as Record<string, ((e: unknown) => void) | undefined>)[name];
          h?.(e);
        };
      }
      return openStream(`/api/v2/sessions/${encodeURIComponent(sessionId)}/stream`, bridge, {});
    },
    handlers,
  );
}

export function useDashboardStream(handlers: EventHandlers): void {
  useGuardedStream(
    "dashboard",
    (latest) => {
      const bridge: EventHandlers = {};
      for (const name of BUS_EVENT_NAMES) {
        (bridge as Record<string, (e: unknown) => void>)[name] = (e) => {
          const h = (latest as Record<string, ((e: unknown) => void) | undefined>)[name];
          h?.(e);
        };
      }
      return openStream("/api/v2/sessions/stream", bridge, {});
    },
    handlers,
  );
}
