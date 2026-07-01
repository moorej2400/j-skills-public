import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { getSessionDetail, isAbortError, listSessions } from "@/lib/api";
import { useDashboardStream } from "@/lib/sse";
import { useSessionStore } from "@/store/sessionStore";
import type { Agent } from "@/lib/types";
import { SessionsGrid } from "@/components/dashboard/SessionsGrid";
import { RecentSessionsList } from "@/components/dashboard/RecentSessionsList";
import { SectionLabel } from "@/components/ui/section-label";
import { partitionSessions } from "@/lib/dashboardPresence";

export default function DashboardPage(): JSX.Element {
  const setSummaries = useSessionStore((s) => s.setSummaries);
  const mergeDetail = useSessionStore((s) => s.mergeDetail);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const summariesMap = useSessionStore((s) => s.summaries);
  const detailsMap = useSessionStore((s) => s.details);
  const dashboardActivity = useSessionStore((s) => s.dashboardActivity);

  const [loading, setLoading] = useState(true);

  // Per-page document title — mirrors SessionPage's "● N busy" prefix so a
  // row of browser tabs surfaces where work is happening (review M13 UX).
  // "Live" here means the session has had activity in the last 60s; the same
  // signal the dashboard sorts by.

  // -------------------------------------------------------------------------
  // Initial REST fetch. The previous implementation re-fetched everything on
  // every SSE event (review C1) — with even a small fleet that was 7+ HTTP
  // requests per 500ms tick. Now: list + details once, and SSE drives all
  // incremental state via `applyEvent`. (The session-list event triggers a list
  // refresh; per-session detail refreshes only happen on `result`/`checkpoint`
  // events for the affected session.)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      try {
        const summaries = await listSessions({
          includeStopped: true,
          sinceDays: 14,
          signal: ac.signal,
        });
        setSummaries(summaries);
        // Pull session details in parallel so we can render agent dots. Cheap
        // SQLite reads against the shared WAL, but still — only on initial load.
        const detailResults = await Promise.allSettled(
          summaries.map((s) => getSessionDetail(s.id, ac.signal)),
        );
        for (const r of detailResults) {
          if (r.status === "fulfilled") mergeDetail(r.value);
        }
      } catch (err) {
        if (!isAbortError(err)) console.error("[dashboard] initial load failed", err);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    };
    void run();
    return () => ac.abort();
  }, [setSummaries, mergeDetail]);

  // Track in-flight session detail refreshes to coalesce bursts (e.g. several
  // `result` events in quick succession on the same session). One outstanding
  // request per session at a time.
  const detailFetchInFlight = useRef<Set<string>>(new Set());
  const refreshSessionDetail = (sessionId: string) => {
    if (detailFetchInFlight.current.has(sessionId)) return;
    detailFetchInFlight.current.add(sessionId);
    getSessionDetail(sessionId)
      .then((d) => mergeDetail(d))
      .catch((err) => {
        if (!isAbortError(err)) console.error("[dashboard] detail refresh failed", err);
      })
      .finally(() => {
        detailFetchInFlight.current.delete(sessionId);
      });
  };

  // List-refresh debounce: a burst of `dashboard:session-list` events should
  // coalesce into one fetch.
  const listRefreshTimer = useRef<number | null>(null);
  const refreshSessions = () => {
    if (listRefreshTimer.current !== null) return;
    listRefreshTimer.current = window.setTimeout(() => {
      listRefreshTimer.current = null;
      listSessions({ includeStopped: true, sinceDays: 14 })
        .then((s) => setSummaries(s))
        .catch((err) => {
          if (!isAbortError(err)) console.error("[dashboard] list refresh failed", err);
        });
    }, 500);
  };
  const handleKilledSession = (result: { sessionId: string }) => {
    refreshSessions();
    refreshSessionDetail(result.sessionId);
  };
  useEffect(
    () => () => {
      if (listRefreshTimer.current !== null) window.clearTimeout(listRefreshTimer.current);
    },
    [],
  );

  // Wire SSE — every event flows into the store via `applyEvent`. Only events
  // that imply data the bus payload can't fully describe trigger a per-session
  // detail refresh (results/checkpoints can include commit shas, summaries,
  // etc., that we want from the authoritative snapshot).
  useDashboardStream({
    "dashboard:session-list": (e) => {
      applyEvent(e);
      refreshSessions();
      // Soft toast on a brand-new session so an operator with the dashboard
      // open in another tab gets a nudge (review N15 UX).
      if (e.reason === "session-created") {
        toast.info(`New session: ${e.sessionId}`, { id: `new-session-${e.sessionId}` });
      }
    },
    agent: (e) => applyEvent(e),
    status: (e) => applyEvent(e),
    runtime: (e) => applyEvent(e),
    heartbeat: (e) => applyEvent(e),
    message: (e) => applyEvent(e),
    assignment: (e) => applyEvent(e),
    result: (e) => {
      applyEvent(e);
      refreshSessionDetail(e.sessionId);
    },
    checkpoint: (e) => {
      applyEvent(e);
      refreshSessionDetail(e.sessionId);
    },
    shutdown: (e) => applyEvent(e),
  });

  // Derive active vs recent partitioning. Terminal sessions must never remain
  // in Live just because the parent agent record is still active. A session is
  // live only while the session itself is active and at least one worker is not
  // stopped.
  const allSessions = useMemo(
    () => Object.values(summariesMap).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [summariesMap],
  );

  const agentsBySession = useMemo(() => {
    const map: Record<string, Agent[]> = {};
    for (const detail of Object.values(detailsMap)) {
      map[detail.session.id] = detail.agents;
    }
    return map;
  }, [detailsMap]);

  const { activeSessions, recentSessions } = useMemo(
    () => partitionSessions(allSessions, agentsBySession),
    [allSessions, agentsBySession],
  );

  // Adapter maps for the grid. Pull the activity slice out of the store and
  // shape it for the existing prop API (could be inlined later).
  const { recentMessagesBySession, lastActivityBySession } = useMemo(() => {
    const recent: Record<string, string[]> = {};
    const last: Record<string, string | undefined> = {};
    for (const [sid, entry] of Object.entries(dashboardActivity)) {
      recent[sid] = entry.recentMessages;
      last[sid] = entry.lastActivityAt ?? undefined;
    }
    return { recentMessagesBySession: recent, lastActivityBySession: last };
  }, [dashboardActivity]);

  // Document title — mirror SessionPage's "● N busy" prefix at the dashboard
  // level. A session is "live" if it had any SSE activity in the last 60s
  // (the same signal active/recent partitioning uses for new sessions). We
  // recompute whenever the activity map changes; no polling needed because
  // SSE events tick `dashboardActivity` and the staleness only matters when
  // it crosses 60s — which the next event will catch in practice.
  const liveSessionCount = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    let n = 0;
    for (const entry of Object.values(dashboardActivity)) {
      if (entry.lastActivityAt && Date.parse(entry.lastActivityAt) >= cutoff) n += 1;
    }
    return n;
  }, [dashboardActivity]);
  useEffect(() => {
    document.title = liveSessionCount > 0
      ? `● (${liveSessionCount} live) · Teamwork`
      : "Teamwork";
    return () => {
      document.title = "Teamwork";
    };
  }, [liveSessionCount]);

  return (
    <div className="space-y-6">
      <motion.header
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="space-y-1"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-base text-muted-foreground">
          Live overview of every teamwork run on this host.
        </p>
      </motion.header>

      <section className="space-y-4 rounded-[1.8rem] border border-border-subtle bg-card/45 p-4 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <SectionLabel as="h2" className="text-sm">
              Live sessions
            </SectionLabel>
            <p className="max-w-[62ch] text-sm text-muted-foreground">
              Active teamwork runs with agent load, phase context, and the latest activity signal.
            </p>
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">
            {activeSessions.length} {activeSessions.length === 1 ? "session" : "sessions"}
          </span>
        </div>
        <SessionsGrid
          sessions={activeSessions}
          agentsBySession={agentsBySession}
          recentMessagesBySession={recentMessagesBySession}
          lastActivityBySession={lastActivityBySession}
          loading={loading}
          onKilled={handleKilledSession}
        />
      </section>

      <section>
        <RecentSessionsList sessions={recentSessions} onKilled={handleKilledSession} />
      </section>
    </div>
  );
}
