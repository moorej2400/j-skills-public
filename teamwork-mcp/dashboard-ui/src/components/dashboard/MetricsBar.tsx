import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  MessageSquare,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Metrics } from "@/lib/types";
import { useSessionStore } from "@/store/sessionStore";
import { DASHBOARD_MESSAGE_WINDOW_MS } from "@/lib/constants";
import { useReducedMotion } from "@/lib/useReducedMotion";

const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export type MetricsBarProps = {
  metrics?: Metrics;
  activeSessionCount: number;
  agentsBusy: number;
  agentsTotal: number;
  loading?: boolean;
};

type Tile = {
  id: string;
  label: string;
  value: string | number;
  sublabel?: string;
  icon: LucideIcon;
  /** Highlight tile with the accent gradient. Used for "live" KPIs. */
  accent?: boolean;
  /** Add the slow shimmer sweep on top of the accent gradient. */
  shimmer?: boolean;
};

export function MetricsBar({
  metrics: _metrics,
  activeSessionCount,
  agentsBusy,
  agentsTotal,
  loading,
}: MetricsBarProps): JSX.Element {
  const reduced = useReducedMotion();
  const dashboardActivity = useSessionStore((s) => s.dashboardActivity);

  const { messagesLastHour, hasRecentActivity } = useMemo(() => {
    const now = Date.now();
    const cutoffHour = now - DASHBOARD_MESSAGE_WINDOW_MS;
    const cutoffRecent = now - RECENT_ACTIVITY_WINDOW_MS;
    let total = 0;
    let recent = 0;
    for (const entry of Object.values(dashboardActivity)) {
      for (const iso of entry.recentMessages) {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) continue;
        if (t >= cutoffHour) total += 1;
        if (t >= cutoffRecent) recent += 1;
      }
    }
    return { messagesLastHour: total, hasRecentActivity: recent >= 1 };
  }, [dashboardActivity]);

  const tiles: Tile[] = [
    {
      id: "active-sessions",
      label: "Active sessions",
      value: activeSessionCount,
      sublabel: activeSessionCount === 1 ? "session live" : "sessions live",
      icon: Activity,
      accent: activeSessionCount > 0,
      shimmer: activeSessionCount > 0 && hasRecentActivity && !reduced,
    },
    {
      id: "agents-busy",
      label: "Agents busy",
      value: agentsBusy,
      sublabel:
        activeSessionCount > 0
          ? `of ${agentsTotal} in live sessions`
          : "no live sessions",
      icon: Users,
    },
    {
      id: "messages-last-hour",
      label: "Messages / hr",
      value: messagesLastHour,
      sublabel: "last 60 minutes",
      icon: MessageSquare,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((tile, idx) => (
        <motion.div
          key={tile.id}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: idx * 0.04, ease: "easeOut" }}
        >
          <MetricsTile tile={tile} loading={loading} />
        </motion.div>
      ))}
    </div>
  );
}

function MetricsTile({ tile, loading }: { tile: Tile; loading?: boolean }): JSX.Element {
  const Icon = tile.icon;
  return (
    <Card
      className={cn(
        "relative overflow-hidden p-5 transition-colors",
        tile.accent && "border-primary/40",
      )}
    >
      {/* Top accent bar on the active tile (review N4 UX). */}
      {tile.accent ? (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
        />
      ) : null}
      {tile.accent ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/25 via-transparent to-transparent"
        />
      ) : null}
      {/* Slow shimmer sweep — fires only when there's recent activity. */}
      {tile.shimmer ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -inset-x-1/2 w-1/3 bg-gradient-to-r from-transparent via-primary/15 to-transparent shimmer-sweep"
        />
      ) : null}
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {tile.label}
            </p>
            {/* KPI in sans + tabular-nums (review H5 UX) — was font-mono. */}
            <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
              {loading ? <Skeleton className="h-8 w-16" /> : tile.value}
            </div>
            {tile.sublabel ? (
              <p className="mt-1 text-sm text-muted-foreground">{tile.sublabel}</p>
            ) : null}
          </div>
        <div
          className={cn(
            "rounded-md border border-border-subtle bg-background/40 p-2 text-muted-foreground",
            tile.accent && "border-primary/40 text-primary",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}
