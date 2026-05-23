import { toast } from "sonner";
import type {
  KillSessionResult,
  Metrics,
  MessagesPage,
  SessionAuditReport,
  SessionDetail,
  SessionSummary,
} from "./types";

// All REST helpers accept an optional `AbortSignal`; pass one from each effect
// so a navigation-triggered cleanup actually cancels the in-flight fetch
// instead of just suppressing its setState (the previous `cancelled` flag
// pattern). The browser will surface aborts as a `DOMException` named
// "AbortError"; callers should ignore those.
async function requestJson<T>(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    // Surface 5xx via a single toast (deduped by id) — do NOT toast 4xx so
    // expected misses (e.g. session not found during a race) stay quiet.
    if (res.status >= 500) {
      toast.error(`Server error (${res.status})`, { id: "api-server-error" });
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail || url}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, { signal });
}

export type ListSessionsParams = {
  sinceDays?: number;
  includeStopped?: boolean;
  signal?: AbortSignal;
};

export function listSessions(
  params: ListSessionsParams = {},
): Promise<SessionSummary[]> {
  const search = new URLSearchParams();
  if (params.sinceDays !== undefined) search.set("sinceDays", String(params.sinceDays));
  if (params.includeStopped !== undefined) search.set("includeStopped", params.includeStopped ? "1" : "0");
  const qs = search.toString();
  return getJson<SessionSummary[]>(
    `/api/v2/sessions${qs ? `?${qs}` : ""}`,
    params.signal,
  );
}

export function getSessionDetail(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return getJson<SessionDetail>(`/api/v2/sessions/${encodeURIComponent(id)}`, signal);
}

export function getMessages(
  id: string,
  sinceId?: string,
  limit?: number,
  signal?: AbortSignal,
  beforeSequence?: number,
): Promise<MessagesPage> {
  const search = new URLSearchParams();
  if (sinceId) search.set("sinceId", sinceId);
  if (limit !== undefined) search.set("limit", String(limit));
  if (beforeSequence !== undefined) search.set("beforeSequence", String(beforeSequence));
  const qs = search.toString();
  return getJson<MessagesPage>(
    `/api/v2/sessions/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ""}`,
    signal,
  );
}

export function getMetrics(sinceDays = 14, signal?: AbortSignal): Promise<Metrics> {
  return getJson<Metrics>(`/api/v2/metrics?sinceDays=${sinceDays}`, signal);
}

export type WorkerOutputChunk = {
  id: number;
  runtimeLogId?: string;
  runtimeId?: string;
  stream?: string;
  chunk: string;
  createdAt: string;
};

export type WorkerOutputPage = {
  chunks: WorkerOutputChunk[];
  nextSinceId: number | null;
};

export function getWorkerOutput(
  sessionId: string,
  agentId: string,
  opts: { sinceId?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<WorkerOutputPage> {
  const search = new URLSearchParams();
  if (opts.sinceId !== undefined) search.set("sinceId", String(opts.sinceId));
  if (opts.limit !== undefined) search.set("limit", String(opts.limit));
  const qs = search.toString();
  return getJson<WorkerOutputPage>(
    `/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/output${qs ? `?${qs}` : ""}`,
    opts.signal,
  );
}

export function getAgentTerminalOutput(
  sessionId: string,
  agentId: string,
  opts: { sinceId?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<WorkerOutputPage> {
  const search = new URLSearchParams();
  if (opts.sinceId !== undefined) search.set("sinceId", String(opts.sinceId));
  if (opts.limit !== undefined) search.set("limit", String(opts.limit));
  const qs = search.toString();
  return getJson<WorkerOutputPage>(
    `/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/terminal${qs ? `?${qs}` : ""}`,
    opts.signal,
  );
}

export function sendRuntimeInput(
  sessionId: string,
  runtimeId: string,
  input: string,
  signal?: AbortSignal,
): Promise<{ runtimeId: string; ok: boolean }> {
  return requestJson<{ runtimeId: string; ok: boolean }>(
    `/api/v2/sessions/${encodeURIComponent(sessionId)}/runtimes/${encodeURIComponent(runtimeId)}/input`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
}

export function resizeRuntimeTerminal(
  sessionId: string,
  runtimeId: string,
  size: { cols: number; rows: number },
  signal?: AbortSignal,
): Promise<{ runtimeId: string; resized: boolean }> {
  return requestJson<{ runtimeId: string; resized: boolean }>(
    `/api/v2/sessions/${encodeURIComponent(sessionId)}/runtimes/${encodeURIComponent(runtimeId)}/resize`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(size),
    },
  );
}

export function getAudit(id: string, signal?: AbortSignal): Promise<SessionAuditReport> {
  return getJson<SessionAuditReport>(
    `/api/v2/sessions/${encodeURIComponent(id)}/audit`,
    signal,
  );
}

export function killSession(id: string, signal?: AbortSignal): Promise<KillSessionResult> {
  return requestJson<KillSessionResult>(
    `/api/v2/sessions/${encodeURIComponent(id)}/kill`,
    { method: "POST", signal },
  );
}

// Convenience: callers in `useEffect` cleanup paths can use this to swallow
// AbortError without a try/catch noise pattern.
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
