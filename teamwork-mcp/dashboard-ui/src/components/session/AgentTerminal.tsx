import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Pause, Play, Trash2, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAgentTerminalOutput, resizeRuntimeTerminal, sendRuntimeInput } from "@/lib/api";
import { subscribeOutput } from "@/store/sessionStore";
import type { BusEventWorkerOutput } from "@/lib/types";

type Props = {
  sessionId: string;
  agentId: string;
  runtimeId?: string;
  inputDelivery?: "stdin" | "resume-command" | "unsupported" | "pty";
};

// Read theme from CSS vars so the terminal stays in sync with light/dark
// switches without re-mount. xterm wants concrete `#rrggbb` strings (it does
// not understand `hsl(var(--…))`), so we resolve via getComputedStyle once.
function buildTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const hsl = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) return fallback;
    return `hsl(${raw})`;
  };
  return {
    background: hsl("--background", "#0b0d11"),
    foreground: hsl("--foreground", "#e7eaf0"),
    cursor: hsl("--primary", "#7aa2f7"),
    cursorAccent: hsl("--background", "#0b0d11"),
    selectionBackground: hsl("--primary", "#7aa2f7") + "33",
  };
}

// `AgentTerminal` is loaded lazily by `AgentSheet`, so the xterm bundle is
// only paid for when the terminal tab actually opens.
export default function AgentTerminal({ sessionId, agentId, runtimeId, inputDelivery }: Props): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSeenIdRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  const queueRef = useRef<BusEventWorkerOutput[]>([]);
  const [paused, setPaused] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [hasAnyOutput, setHasAnyOutput] = useState(false);

  // Keep the ref aligned with the state so the SSE listener (set up once)
  // always reads the freshest paused flag.
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && queueRef.current.length > 0) {
      const term = termRef.current;
      if (term) {
        for (const ev of queueRef.current) term.write(ev.chunk);
      }
      queueRef.current = [];
      setQueuedCount(0);
    }
  }, [paused]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 100000,
      fontFamily: "ui-monospace, JetBrainsMono, monospace",
      fontSize: 12,
      theme: buildTheme(),
      convertEol: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(wrapper);
    try {
      fit.fit();
    } catch {
      /* container may be 0px on first paint; ResizeObserver will retry */
    }
    termRef.current = term;
    fitRef.current = fit;

    let lastResize = { cols: 0, rows: 0 };
    const fitAndResizeRuntime = () => {
      try {
        fit.fit();
        if (runtimeId && inputDelivery === "pty") {
          const { cols, rows } = term;
          if (cols !== lastResize.cols || rows !== lastResize.rows) {
            lastResize = { cols, rows };
            void resizeRuntimeTerminal(sessionId, runtimeId, { cols, rows }).catch((err) => {
              console.warn("[AgentTerminal] resize failed", err);
            });
          }
        }
      } catch {
        /* ignore — happens during teardown */
      }
    };
    const ro = new ResizeObserver(fitAndResizeRuntime);
    ro.observe(wrapper);
    fitAndResizeRuntime();

    let cancelled = false;
    const ac = new AbortController();
    // SSE events that arrive *during* the REST history fetch must not be
    // written to the terminal first — that would put live chunks ahead of
    // older history. Buffer them here, then drain in id order after the
    // REST replay completes (deduping any overlap via lastSeenIdRef).
    let historyLoaded = false;
    const initBuffer: BusEventWorkerOutput[] = [];

    const writeEvent = (event: BusEventWorkerOutput) => {
      if (event.outputId <= lastSeenIdRef.current) return;
      lastSeenIdRef.current = event.outputId;
      setHasAnyOutput(true);
      if (pausedRef.current) {
        queueRef.current.push(event);
        setQueuedCount(queueRef.current.length);
        return;
      }
      term.write(event.chunk);
    };

    const inputDisposable = term.onData((data) => {
      if (!runtimeId || inputDelivery !== "pty") return;
      void sendRuntimeInput(sessionId, runtimeId, data).catch((err) => {
        console.warn("[AgentTerminal] input send failed", err);
      });
    });

    const unsubscribe = subscribeOutput(agentId, (event) => {
      if (!historyLoaded) {
        initBuffer.push(event);
        return;
      }
      writeEvent(event);
    });

    async function loadHistory() {
      let sinceId: number | undefined;
      let loadedAny = false;
      do {
        const page = await getAgentTerminalOutput(sessionId, agentId, { sinceId, limit: 5000, signal: ac.signal });
        if (cancelled) return;
        for (const c of page.chunks) {
          term.write(c.chunk);
          if (c.id > lastSeenIdRef.current) lastSeenIdRef.current = c.id;
        }
        loadedAny = loadedAny || page.chunks.length > 0;
        sinceId = page.nextSinceId ?? undefined;
      } while (sinceId !== undefined && !cancelled);
      if (loadedAny) setHasAnyOutput(true);
    }

    void loadHistory()
      .then(() => {
        if (cancelled) return;
        historyLoaded = true;
        // Drain in id order so out-of-arrival-order chunks still write linearly.
        initBuffer.sort((a, b) => a.outputId - b.outputId);
        for (const ev of initBuffer) writeEvent(ev);
        initBuffer.length = 0;
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[AgentTerminal] history fetch failed", err);
        // Even on history failure, start writing live events so the terminal
        // isn't permanently stuck buffering.
        historyLoaded = true;
        for (const ev of initBuffer) writeEvent(ev);
        initBuffer.length = 0;
      });

    return () => {
      cancelled = true;
      ac.abort();
      unsubscribe();
      inputDisposable.dispose();
      ro.disconnect();
      try {
        links.dispose();
        fit.dispose();
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, agentId, runtimeId, inputDelivery]);

  const onClear = useCallback(() => {
    termRef.current?.clear();
  }, []);

  const onCopyAll = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.normal;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch (err) {
      console.warn("[AgentTerminal] copy failed", err);
    }
  }, []);

  const togglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePause}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="size-3" />
            Clear
          </button>
          <button
            type="button"
            onClick={onCopyAll}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <Copy className="size-3" />
            Copy all
          </button>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-px text-2xs font-medium",
            paused
              ? "bg-status-warning/15 text-status-warning"
              : "bg-status-busy/15 text-status-busy",
          )}
          title={paused ? `Paused (${queuedCount} queued)` : "Live"}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              paused ? "bg-status-warning" : "bg-status-busy animate-pulse",
            )}
          />
          {paused ? `paused (${queuedCount} queued)` : "live"}
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        <div
          ref={wrapperRef}
          className="absolute inset-0 bg-background"
          aria-label="Worker terminal output"
        />
        {!hasAnyOutput && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
            <div className="text-xs text-muted-foreground">
              No runtime output has been captured for this worker yet.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
