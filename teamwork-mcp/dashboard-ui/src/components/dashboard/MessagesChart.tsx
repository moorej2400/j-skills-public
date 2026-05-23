import { memo, useMemo } from "react";
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Metrics } from "@/lib/types";
import { safeFormatChartDate } from "@/lib/utils";

const DIRECT = "hsl(var(--primary))";
// Broadcast now uses the dedicated `--accent-2` cyan token (review H8 UX);
// gives the second series a real semantic identity rather than reading as
// gray noise on the stack.
const BROADCAST = "hsl(var(--accent-2))";

function MessagesChartImpl({
  metrics,
  loading,
}: {
  metrics?: Metrics;
  loading?: boolean;
}): JSX.Element {
  const data = useMemo(() => {
    const series = metrics?.messagesPerDay ?? [];
    return series.slice(-14).map((d) => ({
      date: d.date,
      label: safeFormatChartDate(d.date),
      direct: d.direct,
      broadcast: d.broadcast,
      total: d.direct + d.broadcast,
    }));
  }, [metrics]);

  // Tiny KPI: %change of the trailing 7d total vs the 7d before that.
  const trend = useMemo(() => computeTrend(data.map((d) => d.total)), [data]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            Messages per day
          </CardTitle>
          <TrendChip trend={trend} />
        </div>
      </CardHeader>
      <CardContent className="h-56 pl-2 pr-4">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No message data yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {/* Drop the cartesian grid (review H10 UX). */}
              <XAxis
                dataKey="label"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={28}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                contentStyle={{
                  backgroundColor: "hsl(var(--card-elevated))",
                  border: "1px solid hsl(var(--border-strong))",
                  borderRadius: 8,
                  fontSize: 13,
                }}
                itemStyle={{ color: "hsl(var(--foreground))" }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12, paddingTop: 4 }}
              />
              <Bar dataKey="direct" stackId="m" fill={DIRECT} />
              <Bar dataKey="broadcast" stackId="m" fill={BROADCAST} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function TrendChip({ trend }: { trend: number | null }): JSX.Element {
  if (trend === null || !Number.isFinite(trend)) {
      return (
      <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
        direct + broadcast
      </span>
    );
  }
  const up = trend >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs tabular-nums ${
        up ? "text-status-success" : "text-status-stopped"
      }`}
    >
      <Icon className="h-3 w-3" />
      {up ? "+" : ""}
      {Math.round(trend)}% vs prior 7d
    </span>
  );
}

function computeTrend(values: number[]): number | null {
  if (values.length < 14) return null;
  const recent = values.slice(-7).reduce((a, b) => a + b, 0);
  const prior = values.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (prior === 0) return recent > 0 ? 100 : 0;
  return ((recent - prior) / prior) * 100;
}

export const MessagesChart = memo(MessagesChartImpl);
