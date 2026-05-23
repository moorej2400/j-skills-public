import { create } from "zustand";
import type {
  BusEvent,
  Heartbeat,
  Message,
  Session,
  SessionDetail,
  SessionSummary,
} from "@/lib/types";
import { DASHBOARD_MESSAGE_WINDOW_MS } from "@/lib/constants";

// Stable empty-array references so selectors of the form `s.messages[id] ?? EMPTY`
// don't return a fresh array on every render (which would invalidate any
// downstream `useMemo` with `messages` in its deps). See review M14. Typed as
// the same `Message[]` shape as the live arrays so consumers don't need a
// readonly cast — but treat as immutable in practice.
export const EMPTY_MESSAGES: Message[] = [];

export type DashboardActivity = {
  // ISO timestamps of message events observed within the rolling window. Used
  // by the per-card sparkline and the dashboard "messages last hour" tile.
  recentMessages: string[];
  // Most-recent activity (any SSE event) for the card footer.
  lastActivityAt: string | null;
};

type State = {
  // `summaries` powers the dashboard list page (thin wire shape).
  summaries: Record<string, SessionSummary>;
  // `sessions` only populated for sessions whose detail was fetched (full
  // workerPool, etc.); used by SessionPage.
  sessions: Record<string, Session>;
  details: Record<string, SessionDetail>;
  messages: Record<string, Message[]>;
  dashboardActivity: Record<string, DashboardActivity>;
  // UI: Cmd-K palette open state, mirrored here so the TopBar trigger and the
  // global keydown listener share one source of truth.
  paletteOpen: boolean;
  // UI: cross-component agent-selection signal. SessionPage subscribes and
  // opens the AgentSheet when this is set; the palette and `Enter` on a
  // focused AgentCard both fire `selectAgent(id)`.
  selectedAgentId: string | null;
};

type Actions = {
  setSummaries: (summaries: SessionSummary[]) => void;
  mergeDetail: (detail: SessionDetail) => void;
  appendMessages: (sessionId: string, messages: Message[]) => void;
  applyEvent: (event: BusEvent) => void;
  setPaletteOpen: (open: boolean) => void;
  selectAgent: (agentId: string | null) => void;
  reset: () => void;
};

const initial: State = {
  summaries: {},
  sessions: {},
  details: {},
  messages: {},
  dashboardActivity: {},
  paletteOpen: false,
  selectedAgentId: null,
};

export const useSessionStore = create<State & Actions>((set) => ({
  ...initial,

  setSummaries: (summaries) =>
    set((s) => {
      const next: Record<string, SessionSummary> = { ...s.summaries };
      for (const sess of summaries) next[sess.id] = sess;
      return { summaries: next };
    }),

  mergeDetail: (detail) =>
    set((s) => ({
      details: { ...s.details, [detail.session.id]: detail },
      sessions: { ...s.sessions, [detail.session.id]: detail.session },
    })),

  appendMessages: (sessionId, messages) =>
    set((s) => {
      const existing = s.messages[sessionId] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const merged = [...existing];
      for (const m of messages) {
        if (!seen.has(m.id)) {
          merged.push(m);
          seen.add(m.id);
        }
      }
      // Historical pagination can merge an older page after the latest page.
      // Keep the canonical stream chronological for the timeline and 3D viz.
      merged.sort((a, b) => a.sequence - b.sequence);
      return { messages: { ...s.messages, [sessionId]: merged } };
    }),

  // applyEvent: typed by `BusEvent` so each branch narrows on `event.topic`
  // (and on `event.kind` for `message`). Detail merges no-op if the detail
  // hasn't been fetched yet — the next REST refresh will fill it in.
  // Dashboard-only state (activity buffers, summary lastActivity) updates
  // unconditionally so the index page stays live without a detail fetch.
  applyEvent: (event) =>
    set((s) => {
      const sessionId = "sessionId" in event ? event.sessionId : null;

      // Stamp dashboard activity on every per-session event (everything except
      // `dashboard:session-list`, which only signals that the list itself
      // changed).
      let dashboardActivity = s.dashboardActivity;
      let summaries = s.summaries;
      if (sessionId && event.topic !== "dashboard:session-list") {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const cur = dashboardActivity[sessionId] ?? { recentMessages: [], lastActivityAt: null };
        const isMessageSent = event.topic === "message" && event.kind === "sent";
        let recentMessages = cur.recentMessages;
        if (isMessageSent) {
          const cutoff = nowMs - DASHBOARD_MESSAGE_WINDOW_MS;
          // The sent payload covers N targets; count each target as one
          // delivery (matches the per-row count the server stores).
          const fanout = (event as Extract<BusEvent, { topic: "message"; kind: "sent" }>).toAgentIds.length || 1;
          const trimmed = recentMessages.filter((t) => Date.parse(t) >= cutoff);
          for (let i = 0; i < fanout; i += 1) trimmed.push(nowIso);
          recentMessages = trimmed;
        }
        dashboardActivity = {
          ...dashboardActivity,
          [sessionId]: { recentMessages, lastActivityAt: nowIso },
        };
        // Mirror onto the summary's lastActivityAt so the index list sorts
        // freshly without a refetch.
        const sum = summaries[sessionId];
        if (sum) {
          summaries = { ...summaries, [sessionId]: { ...sum, lastActivityAt: nowIso } };
        }
      }

      const existing = sessionId ? s.details[sessionId] : undefined;

      // Helper used by every branch that mutates a detail subtree. Returns the
      // new state object including the dashboard-side mutations above.
      const withDetail = (detail: SessionDetail): State => ({
        ...s,
        details: { ...s.details, [sessionId!]: detail },
        dashboardActivity,
        summaries,
      });
      const noDetailChange = (): State => ({
        ...s,
        dashboardActivity,
        summaries,
      });

      switch (event.topic) {
        case "agent": {
          if (!existing) return noDetailChange();
          const agents = upsertById(existing.agents, event.agent, "agentId");
          return withDetail({
            ...existing,
            agents,
            counts: { ...existing.counts, agents: agents.length },
          });
        }
        case "status": {
          if (!existing) return noDetailChange();
          const agents = existing.agents.map((a) =>
            a.agentId === event.agentId ? { ...a, status: event.status } : a,
          );
          return withDetail({ ...existing, agents });
        }
        case "runtime": {
          if (!existing) return noDetailChange();
          const agents = existing.agents.map((a) =>
            a.agentId === event.agentId ? { ...a, runtime: event.runtime } : a,
          );
          return withDetail({ ...existing, agents });
        }
        case "heartbeat": {
          if (!existing) return noDetailChange();
          const heartbeat: Heartbeat = {
            agentId: event.agentId,
            summary: event.summary,
            updatedAt: event.updatedAt,
          };
          const agents = existing.agents.map((a) =>
            a.agentId === event.agentId ? { ...a, heartbeat } : a,
          );
          return withDetail({ ...existing, agents });
        }
        case "assignment": {
          if (!existing) return noDetailChange();
          const assignments = upsertById(existing.assignments, event.assignment, "id");
          return withDetail({ ...existing, assignments });
        }
        case "result": {
          if (!existing) return noDetailChange();
          const results = upsertById(existing.results, event.result, "id");
          return withDetail({
            ...existing,
            results,
            counts: { ...existing.counts, results: results.length },
          });
        }
        case "checkpoint": {
          if (!existing) return noDetailChange();
          const checkpoints = upsertById(existing.checkpoints, event.checkpoint, "id");
          return withDetail({ ...existing, checkpoints });
        }
        case "message": {
          if (!existing) return noDetailChange();
          if (event.kind === "sent") {
            // Bump the count optimistically by the per-row fan-out. The next
            // REST snapshot will overwrite this with the authoritative number,
            // but during the debounce window the counter still ticks live.
            return withDetail({
              ...existing,
              counts: {
                ...existing.counts,
                messages: existing.counts.messages + (event.toAgentIds.length || 1),
              },
            });
          }
          return noDetailChange();
        }
        case "output": {
          // Output is high-volume and never persisted in the store — fan out
          // to subscribers (the AgentTerminal panel) instead. We still stamp
          // dashboard activity above so the session card animates while a
          // worker is producing output.
          dispatchOutput(event);
          return noDetailChange();
        }
        case "shutdown":
        case "dashboard:session-list":
          return noDetailChange();
        default: {
          // Exhaustiveness check: if a new BusEventName is added to the union
          // without a case here, this assignment will fail to typecheck.
          const _exhaustive: never = event;
          void _exhaustive;
          return noDetailChange();
        }
      }
    }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  selectAgent: (agentId) => set({ selectedAgentId: agentId }),

  reset: () => {
    clearOutputBuffers();
    set(initial);
  },
}));

// ---------------------------------------------------------------------------
// Worker output fan-out — kept outside the zustand store because output is
// high-volume (1 chunk per stdout flush) and we don't want each chunk to push
// a new state snapshot through React. Subscribers receive events directly via
// a per-agent subscriber set; the recent-history ring keeps the last N chunks
// per agent so a terminal mounted *after* events arrived can replay them
// (bounded; the REST endpoint backfills longer history).
// ---------------------------------------------------------------------------

import type { BusEventWorkerOutput } from "@/lib/types";

const OUTPUT_BUFFER_PER_AGENT = 1000;
type OutputListener = (event: BusEventWorkerOutput) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const outputBuffers = new Map<string, BusEventWorkerOutput[]>();

function dispatchOutput(event: BusEventWorkerOutput): void {
  const buf = outputBuffers.get(event.agentId) ?? [];
  buf.push(event);
  if (buf.length > OUTPUT_BUFFER_PER_AGENT) buf.splice(0, buf.length - OUTPUT_BUFFER_PER_AGENT);
  outputBuffers.set(event.agentId, buf);
  const listeners = outputListeners.get(event.agentId);
  if (!listeners) return;
  for (const cb of listeners) {
    try {
      cb(event);
    } catch (err) {
      console.warn("[sessionStore] output listener threw", err);
    }
  }
}

export function subscribeOutput(agentId: string, cb: OutputListener): () => void {
  let set = outputListeners.get(agentId);
  if (!set) {
    set = new Set();
    outputListeners.set(agentId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) {
      outputListeners.delete(agentId);
      // Drop the per-agent buffer too, otherwise retired agents pin up to
      // 1000 chunks each for the lifetime of the tab.
      outputBuffers.delete(agentId);
    }
  };
}

export function clearOutputBuffers(): void {
  outputListeners.clear();
  outputBuffers.clear();
}

export function getBufferedOutput(agentId: string): BusEventWorkerOutput[] {
  return outputBuffers.get(agentId) ?? [];
}

function upsertById<T, K extends keyof T>(arr: T[], item: T, key: K): T[] {
  const idx = arr.findIndex((existing) => existing[key] === item[key]);
  if (idx === -1) return [...arr, item];
  const next = arr.slice();
  next[idx] = item;
  return next;
}
