import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, CheckCircle2, Search, XCircle } from "lucide-react";
import { getMetrics, listSessions } from "@/lib/api";
import type { Metrics, SessionSummary } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["all", "active", "completed", "abandoned", "archived"] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

export default function HistoryPage(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [metrics, setMetrics] = useState<Metrics | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const nowMs = useNow();

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    Promise.all([
      listSessions({ includeStopped: true, sinceDays: 365, signal: ac.signal }),
      getMetrics(365, ac.signal),
    ])
      .then(([rows, m]) => {
        if (ac.signal.aborted) return;
        setSessions(rows);
        setMetrics(m);
      })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.error("[history] load failed", err);
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (status !== "all" && (s.status ?? "active") !== status) return false;
      if (!q) return true;
      return (
        s.slug.toLowerCase().includes(q) ||
        (s.title?.toLowerCase().includes(q) ?? false) ||
        s.parentCli.toLowerCase().includes(q)
      );
    });
  }, [sessions, query, status]);

  const totals = useMemo(() => {
    const totalMessages = metrics?.messagesPerDay.reduce((sum, d) => sum + d.direct + d.broadcast, 0) ?? 0;
    return {
      sessions: sessions.length,
      completed: sessions.filter((s) => (s.status ?? "active") === "completed").length,
      abandoned: sessions.filter((s) => (s.status ?? "active") === "abandoned").length,
      messages: totalMessages,
    };
  }, [sessions, metrics]);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Session History</h1>
        <p className="text-sm text-muted-foreground">
          Completed, abandoned, and archived teamwork runs on this host.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-4">
        <HistoryMetric label="sessions" value={totals.sessions} loading={loading} icon={<Archive className="size-4" />} />
        <HistoryMetric label="completed" value={totals.completed} loading={loading} icon={<CheckCircle2 className="size-4" />} />
        <HistoryMetric label="abandoned" value={totals.abandoned} loading={loading} icon={<XCircle className="size-4" />} />
        <HistoryMetric label="messages" value={totals.messages} loading={loading} icon={<Search className="size-4" />} />
      </div>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <SectionLabel as="h2" className="text-xs">
            Browse
          </SectionLabel>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, slug, CLI"
                className="h-9 w-full rounded-md border bg-background pl-7 pr-2 text-sm outline-none transition focus:border-primary sm:w-72"
              />
            </label>
            <div className="inline-flex h-9 items-center overflow-x-auto rounded-md border bg-background p-0.5">
              {STATUS_FILTERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatus(value)}
                  className={cn(
                    "h-8 rounded px-2.5 text-2xs uppercase tracking-wider transition",
                    status === value
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              No sessions match the current filters.
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1.7fr)_8rem_8rem_8rem_7rem] gap-3 border-b bg-muted/30 px-3 py-2 text-2xs uppercase tracking-wider text-muted-foreground max-lg:hidden">
              <div>Session</div>
              <div>Status</div>
              <div>Stage</div>
              <div>Last activity</div>
              <div className="text-right">Agents</div>
            </div>
            <ul className="divide-y divide-border-subtle">
              {filtered.map((session) => (
                <li key={session.id}>
                  <Link
                    to={`/sessions/${session.id}`}
                    className="grid gap-3 px-3 py-3 transition-colors hover:bg-secondary/40 lg:grid-cols-[minmax(0,1.7fr)_8rem_8rem_8rem_7rem]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {session.title || session.slug}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <code className="truncate font-mono">{session.slug}</code>
                        <Badge variant="secondary" className="text-2xs uppercase tracking-wider">
                          {session.parentCli}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <StatusBadge status={session.status ?? "active"} />
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      {session.lifecycleStage ?? "unknown"}
                    </div>
                    <div className="flex items-center font-mono text-xs text-muted-foreground">
                      {relativeTime(session.lastActivityAt ?? session.createdAt, nowMs)}
                    </div>
                    <div className="flex items-center justify-start font-mono text-xs text-muted-foreground lg:justify-end">
                      {session.agentCount}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryMetric({
  label,
  value,
  icon,
  loading,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  loading: boolean;
}): JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
          {loading ? <Skeleton className="mt-2 h-5 w-14" /> : <div className="text-xl font-semibold tabular-nums">{value}</div>}
        </div>
        <div className="rounded-md bg-muted p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: NonNullable<SessionSummary["status"]> }): JSX.Element {
  const cls =
    status === "active"
      ? "border-status-busy/30 bg-status-busy/10 text-status-busy"
      : status === "completed"
        ? "border-status-idle/30 bg-status-idle/10 text-status-idle"
        : status === "abandoned"
          ? "border-status-warning/30 bg-status-warning/10 text-status-warning"
          : "border-border-subtle bg-muted text-muted-foreground";
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-2xs uppercase tracking-wider", cls)}>
      {status}
    </span>
  );
}
