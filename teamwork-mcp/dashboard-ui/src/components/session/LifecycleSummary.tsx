import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import type { SessionDetail, Message } from "@/lib/types";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { Activity, Flag, Circle } from "lucide-react";

type Props = {
  detail: SessionDetail;
  messages: Message[];
};

export function LifecycleSummary({ detail, messages }: Props): JSX.Element {
  const nowMs = useNow();
  const { lastCheckpoint, lastActivityIso } = useMemo(() => {
    const lastCp = [...detail.checkpoints].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    let maxTs = -Infinity;
    let maxIso: string | undefined;
    const consider = (iso: string | undefined) => {
      if (!iso) return;
      const t = Date.parse(iso);
      if (!Number.isNaN(t) && t > maxTs) {
        maxTs = t;
        maxIso = iso;
      }
    };
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) consider(lastMsg.createdAt);
    for (const r of detail.results) consider(r.createdAt);
    for (const a of detail.agents) {
      consider(a.heartbeat?.updatedAt);
      consider(a.status?.updatedAt);
    }
    return { lastCheckpoint: lastCp, lastActivityIso: maxIso };
  }, [detail.checkpoints, detail.results, detail.agents, messages]);

  const busy = detail.agents.filter((a) => a.status.state === "busy").length;
  const idle = detail.agents.filter((a) => a.status.state === "idle").length;
  const stopped = detail.agents.filter((a) => a.status.state === "stopped").length;
  const totalAgents = detail.agents.length;
  const total = totalAgents || 1;
  const accountedFraction = (busy + idle + stopped) / total;
  const lastActivity = lastActivityIso;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <SectionLabel>
          <Activity className="size-3" />
          lifecycle
        </SectionLabel>

        <div className="space-y-2">
          <Row label="last activity" value={relativeTime(lastActivity, nowMs)} />
          <Row
            label="last checkpoint"
            value={lastCheckpoint ? relativeTime(lastCheckpoint.createdAt, nowMs) : "—"}
            hint={lastCheckpoint?.summary}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">agents</span>
            <span className="tabular-nums text-muted-foreground">
              {totalAgents > 0 ? `${busy}/${totalAgents} busy` : "—"}
            </span>
          </div>
          {/* Status segments use the new --status-* tokens (review H1). When
              the registered/accounted fractions don't sum to 100 (review M3),
              we fill the remainder with a `border-subtle` segment so the bar
              never reads as truncated data. */}
          <div className="relative flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="bg-status-busy" style={{ width: `${(busy / total) * 100}%` }} />
            <div className="bg-status-idle/70" style={{ width: `${(idle / total) * 100}%` }} />
            <div className="bg-status-stopped/70" style={{ width: `${(stopped / total) * 100}%` }} />
            {accountedFraction < 1 && totalAgents > 0 ? (
              <div
                className="bg-border-subtle/60"
                style={{ width: `${(1 - accountedFraction) * 100}%` }}
                aria-hidden
              />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <Legend dotClass="bg-status-busy" label="busy" count={busy} />
            <Legend dotClass="bg-status-idle/80" label="idle" count={idle} />
            <Legend dotClass="bg-status-stopped/80" label="stopped" count={stopped} />
          </div>
        </div>

        {lastCheckpoint?.summary && (
          <div className="rounded-md border-l-2 border-primary/60 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground line-clamp-2">
            <Flag className="inline size-3 mr-1 -mt-0.5 text-primary/80" />
            {lastCheckpoint.summary}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {/* sans + tabular-nums: relative time is human-readable, not code. */}
      <span className="tabular-nums" title={hint}>
        {value}
      </span>
    </div>
  );
}

function Legend({ dotClass, label, count }: { dotClass: string; label: string; count: number }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Circle className={`size-2 rounded-full ${dotClass}`} fill="currentColor" stroke="none" />
      <span>{label}</span>
      <span className="tabular-nums text-foreground/80">{count}</span>
    </span>
  );
}
