import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { killSessionFromDashboard } from "./dashboard-actions.js";
import { DashboardService } from "./dashboard-service.js";
import { bus, sessionTopicsFor, type BusEvent, type TopicName } from "./event-bus.js";
import type { TeamworkStore } from "./store.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DIST = resolve(__dirname, "..", "dashboard-ui", "dist");
const DASHBOARD_DIST = process.env.TEAMWORK_DASHBOARD_DIST ?? DEFAULT_DIST;

const MAX_SSE_CONNECTIONS = 64;
// Drop a slow consumer rather than buffer unbounded. If the kernel write
// queue stays saturated past either of these caps we close the connection
// and let the client reconnect (with Last-Event-ID replay).
const SSE_BACKPRESSURE_QUEUE_LIMIT = 200;
const SSE_BACKPRESSURE_BYTES_LIMIT = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(value));
}

function badRequest(res: ServerResponse, msg: string) { sendJson(res, 400, { error: msg }); }
function notFound(res: ServerResponse, msg = "not found") { sendJson(res, 404, { error: msg }); }
function methodNotAllowed(res: ServerResponse, allow = "GET") {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "method not allowed" }));
}

function parseBoolean(raw: string): boolean | null {
  const s = raw.toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return null;
}

function parsePositiveInt(raw: string, def: number, min: number, max: number): number | null {
  if (raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  if (!raw || Array.isArray(raw)) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function tryServeStatic(pathname: string, res: ServerResponse, acceptHtml: boolean): boolean {
  if (!existsSync(DASHBOARD_DIST)) {
    if (!acceptHtml) return false;
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Teamwork</title>
       <body style="font-family:system-ui;background:#0c0c10;color:#e7e7ea;padding:32px;">
       <h1 style="margin:0 0 8px 0;">Teamwork dashboard</h1>
       <p>UI is not built yet. Run <code>npm run dashboard:build</code> in <code>teamwork-mcp/</code>.</p>
       </body>`
    );
    return true;
  }

  const safe = normalize(pathname).replace(/^[/\\]+/, "");
  const candidate = resolve(DASHBOARD_DIST, safe);
  const rel = relative(DASHBOARD_DIST, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) return false;

  let target = candidate;
  let exists = false;
  try {
    exists = statSync(target).isFile();
  } catch {
    exists = false;
  }
  if (!exists && acceptHtml) {
    target = join(DASHBOARD_DIST, "index.html");
    try {
      exists = statSync(target).isFile();
    } catch {
      exists = false;
    }
  }
  if (!exists) return false;

  const isIndex = target.toLowerCase().endsWith("index.html");
  const inAssets = target.includes(`${"/"}assets${"/"}`);
  res.statusCode = 200;
  res.setHeader("content-type", isIndex ? MIME[".html"]! : mimeFor(target));
  if (isIndex) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("vary", "Accept");
  } else if (inAssets) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  }
  res.end(readFileSync(target));
  return true;
}

const activeStreams = new Set<{ close: () => void }>();

function makeSseStream(
  res: ServerResponse,
  req: IncomingMessage,
  topics: TopicName[],
  lastEventId: number
): void {
  if (activeStreams.size >= MAX_SSE_CONNECTIONS) {
    sendJson(res, 503, { error: "too many sse connections" });
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  const handle = { close: () => cleanup() };
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let pendingBytes = 0;
  let pendingEvents = 0;
  const unsubs: Array<() => void> = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    for (const u of unsubs) u();
    activeStreams.delete(handle);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  const writeFrame = (frame: string) => {
    if (closed) return;
    const drained = res.write(frame);
    pendingEvents += 1;
    pendingBytes += Buffer.byteLength(frame, "utf8");
    if (
      !drained &&
      (pendingBytes > SSE_BACKPRESSURE_BYTES_LIMIT ||
        pendingEvents > SSE_BACKPRESSURE_QUEUE_LIMIT)
    ) {
      cleanup();
    }
  };
  // Decrement the backpressure counters when the socket actually drains so a
  // burst followed by a quiet period doesn't permanently look "saturated."
  res.on("drain", () => {
    pendingEvents = 0;
    pendingBytes = 0;
  });

  const writeEvent = (id: number, eventName: string, payload: unknown) => {
    writeFrame(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  activeStreams.add(handle);

  res.write(": stream-open\nretry: 5000\n\n");

  if (lastEventId > 0) {
    const replay: BusEvent[] = [];
    for (const topic of topics) {
      for (const ev of bus.getSince(topic, lastEventId)) replay.push(ev);
    }
    replay.sort((a, b) => a.id - b.id);
    for (const ev of replay) writeEvent(ev.id, ev.topic, ev);
  }

  for (const topic of topics) {
    const unsub = bus.on(topic, (payload: BusEvent) => {
      writeEvent(payload.id, payload.topic, payload);
    });
    unsubs.push(unsub);
  }

  heartbeat = setInterval(() => {
    writeFrame(`event: heartbeat\ndata: {}\n\n`);
  }, 15_000);
}

export function shutdownAllSseStreams(): void {
  for (const s of [...activeStreams]) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}

// Returns true if it handled the request, false to fall through to the legacy
// route table in server.ts.
export function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: TeamworkStore,
  workerSupervisor: WorkerSupervisor,
): boolean {
  const service = new DashboardService(store);
  const pathname = url.pathname;
  const accept = (req.headers.accept ?? "") as string;
  const acceptHtml = accept.includes("text/html");

  try {
    // ---------- API ----------
    if (!pathname.startsWith("/api/v2/") && pathname.startsWith("/api/")) {
      // Leave non-v2 API paths to the legacy route table in server.ts.
      return false;
    }
    if (pathname === "/api/v2/sessions") {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      const opts: { sinceDays?: number; includeStopped?: boolean } = {};
      const sinceDaysRaw = url.searchParams.get("sinceDays");
      if (sinceDaysRaw !== null) {
        const v = parsePositiveInt(sinceDaysRaw, 0, 0, 3650);
        if (v === null) { badRequest(res, "invalid sinceDays"); return true; }
        opts.sinceDays = v;
      }
      const includeStoppedRaw = url.searchParams.get("includeStopped");
      if (includeStoppedRaw !== null) {
        if (includeStoppedRaw === "") {
          opts.includeStopped = true;
        } else {
          const b = parseBoolean(includeStoppedRaw);
          if (b === null) { badRequest(res, "invalid includeStopped"); return true; }
          opts.includeStopped = b;
        }
      }
      sendJson(res, 200, service.listSessions(opts));
      return true;
    }

    if (pathname === "/api/v2/sessions/stream") {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      makeSseStream(res, req, ["dashboard:session-list"], parseLastEventId(req));
      return true;
    }

    if (pathname === "/api/v2/metrics") {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      const sinceDaysRaw = url.searchParams.get("sinceDays");
      let sinceDays = 14;
      if (sinceDaysRaw !== null) {
        const v = parsePositiveInt(sinceDaysRaw, 14, 1, 3650);
        if (v === null) { badRequest(res, "invalid sinceDays"); return true; }
        sinceDays = v;
      }
      sendJson(res, 200, service.getMetrics({ sinceDays }));
      return true;
    }

    const killMatch = pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/kill$/);
    if (killMatch) {
      if (req.method !== "POST") { methodNotAllowed(res, "POST"); return true; }
      const sessionId = decodeURIComponent(killMatch[1] ?? "");
      if (!sessionId) { badRequest(res, "missing session id"); return true; }
      try {
        sendJson(res, 200, killSessionFromDashboard(store, workerSupervisor, sessionId));
      } catch {
        notFound(res, "session not found");
      }
      return true;
    }

    const outputMatch = pathname.match(
      /^\/api\/v2\/sessions\/([^/]+)\/agents\/([^/]+)\/output$/
    );
    if (outputMatch) {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      const sessionId = decodeURIComponent(outputMatch[1] ?? "");
      const agentId = decodeURIComponent(outputMatch[2] ?? "");
      if (!sessionId || !agentId) { badRequest(res, "missing id"); return true; }
      if (!service.hasSession(sessionId)) { notFound(res, "session not found"); return true; }
      const sinceIdRaw = url.searchParams.get("sinceId");
      const limitRaw = url.searchParams.get("limit");
      const args: { sessionId: string; agentId: string; sinceId?: number; limit?: number } = {
        sessionId,
        agentId,
      };
      if (sinceIdRaw !== null) {
        const v = parsePositiveInt(sinceIdRaw, 0, 0, Number.MAX_SAFE_INTEGER);
        if (v === null) { badRequest(res, "invalid sinceId"); return true; }
        args.sinceId = v;
      }
      if (limitRaw !== null) {
        const v = parsePositiveInt(limitRaw, 500, 1, 2000);
        if (v === null) { badRequest(res, "invalid limit"); return true; }
        args.limit = v;
      }
      try {
        sendJson(res, 200, service.getWorkerOutput(args));
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("does not belong to session")) {
          notFound(res, "agent not found");
          return true;
        }
        throw err;
      }
      return true;
    }

    const terminalMatch = pathname.match(
      /^\/api\/v2\/sessions\/([^/]+)\/agents\/([^/]+)\/terminal$/
    );
    if (terminalMatch) {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      const sessionId = decodeURIComponent(terminalMatch[1] ?? "");
      const agentId = decodeURIComponent(terminalMatch[2] ?? "");
      if (!sessionId || !agentId) { badRequest(res, "missing id"); return true; }
      if (!service.hasSession(sessionId)) { notFound(res, "session not found"); return true; }
      const sinceIdRaw = url.searchParams.get("sinceId");
      const limitRaw = url.searchParams.get("limit");
      const args: { sessionId: string; agentId: string; sinceId?: number; limit?: number } = {
        sessionId,
        agentId,
      };
      if (sinceIdRaw !== null) {
        const v = parsePositiveInt(sinceIdRaw, 0, 0, Number.MAX_SAFE_INTEGER);
        if (v === null) { badRequest(res, "invalid sinceId"); return true; }
        args.sinceId = v;
      }
      if (limitRaw !== null) {
        const v = parsePositiveInt(limitRaw, 1000, 1, 5000);
        if (v === null) { badRequest(res, "invalid limit"); return true; }
        args.limit = v;
      }
      try {
        sendJson(res, 200, service.getAgentTerminalOutput(args));
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("does not belong to session")) {
          notFound(res, "agent not found");
          return true;
        }
        throw err;
      }
      return true;
    }

    const runtimeInputMatch = pathname.match(
      /^\/api\/v2\/sessions\/([^/]+)\/runtimes\/([^/]+)\/(input|resize)$/
    );
    if (runtimeInputMatch) {
      if (req.method !== "POST") { methodNotAllowed(res, "POST"); return true; }
      const sessionId = decodeURIComponent(runtimeInputMatch[1] ?? "");
      const runtimeId = decodeURIComponent(runtimeInputMatch[2] ?? "");
      const action = runtimeInputMatch[3];
      if (!sessionId || !runtimeId) { badRequest(res, "missing id"); return true; }
      void readJsonBody(req)
        .then((body) => {
          if (action === "resize") {
            const cols = Number((body as { cols?: unknown }).cols);
            const rows = Number((body as { rows?: unknown }).rows);
            if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 400 || rows > 200) {
              badRequest(res, "invalid terminal size");
              return;
            }
            sendJson(res, 200, workerSupervisor.resizeDashboardTerminal({ sessionId, runtimeId, cols, rows }));
            return;
          }
          const input = typeof (body as { input?: unknown }).input === "string"
            ? (body as { input: string }).input
            : "";
          if (!input) {
            badRequest(res, "missing input");
            return;
          }
          sendJson(res, 200, workerSupervisor.sendDashboardInput({ sessionId, runtimeId, input, raw: true }));
        })
        .catch((err) => {
          badRequest(res, (err as Error).message || "invalid request body");
        });
      return true;
    }

    const sessionMatch = pathname.match(
      /^\/api\/v2\/sessions\/([^/]+)(?:\/(messages|audit|stream))?$/
    );
    if (sessionMatch) {
      if (req.method !== "GET") { methodNotAllowed(res); return true; }
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const sub = sessionMatch[2];
      if (!sessionId) { badRequest(res, "missing session id"); return true; }
      if (!sub) {
        try {
          sendJson(res, 200, service.getSessionDetail(sessionId));
        } catch {
          notFound(res, "session not found");
        }
        return true;
      }
      if (sub === "audit") {
        try {
          sendJson(res, 200, service.getAuditReport(sessionId));
        } catch {
          notFound(res, "session not found");
        }
        return true;
      }
      if (sub === "messages") {
        const sinceId = url.searchParams.get("sinceId") ?? undefined;
        if (sinceId !== undefined && sinceId.length > 1024) {
          badRequest(res, "invalid sinceId");
          return true;
        }
        const beforeSequenceRaw = url.searchParams.get("beforeSequence");
        const limitRaw = url.searchParams.get("limit");
        const args: { sessionId: string; sinceId?: string; beforeSequence?: number; limit?: number } = { sessionId };
        if (sinceId !== undefined) args.sinceId = sinceId;
        if (beforeSequenceRaw !== null) {
          const v = parsePositiveInt(beforeSequenceRaw, 1, 1, Number.MAX_SAFE_INTEGER);
          if (v === null) { badRequest(res, "invalid beforeSequence"); return true; }
          args.beforeSequence = v;
        }
        if (limitRaw !== null) {
          const v = parsePositiveInt(limitRaw, 200, 1, 1000);
          if (v === null) { badRequest(res, "invalid limit"); return true; }
          args.limit = v;
        }
        sendJson(res, 200, service.listMessagesPage(args));
        return true;
      }
      if (sub === "stream") {
        if (!service.hasSession(sessionId)) { notFound(res, "session not found"); return true; }
        makeSseStream(res, req, sessionTopicsFor(sessionId), parseLastEventId(req));
        return true;
      }
    }

    // ---------- Static SPA fallback ----------
    if ((req.method === "GET" || req.method === "HEAD") && !pathname.startsWith("/api/")) {
      const target = pathname === "/" ? "/index.html" : pathname;
      if (tryServeStatic(target, res, acceptHtml)) return true;
    }
  } catch (err) {
    process.stderr.write(`[dashboard] ${(err as Error).stack ?? String(err)}\n`);
    sendJson(res, 500, { error: "internal error" });
    return true;
  }

  return false;
}
