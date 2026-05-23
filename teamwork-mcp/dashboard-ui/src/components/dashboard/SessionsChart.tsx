import { memo, useMemo } from "react";
import {
  Area,
  AreaChart,
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

const PRIMARY = "hsl(var(--primary))";

function SessionsChartImpl({
  metrics,
  loading,
}: {
  metrics?: Metrics;
  loading?: boolean;
}): JSX.Element {
  const data = useMemo(() => {
    const series = metrics?.sessionsPerDay ?? [];
    return series.slice(-14).map((d) => ({
      date: d.date,
      label: safeFormatChartDate(d.date),
      count: d.count,
    }));
  }, [metrics]);

  const trend = useMemo(() => computeTrend(data.map((d) => d.count)), [data]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between">
          <CardTitle className="text-sm font-semibold tracking-tight">
            Sessions per day
          </CardTitle>
          <TrendChip trend={trend} />
        </div>
      </CardHeader>
      <CardContent className="h-56 pl-2 pr-4">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sessions-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              {/* No grid (review H10 UX) — clean area for the curve. */}
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
                cursor={{ stroke: "hsl(var(--border))" }}
                contentStyle={{
                  backgroundColor: "hsl(var(--card-elevated))",
                  border: "1px solid hsl(var(--border-strong))",
                  borderRadius: 8,
                  fontSize: 13,
                }}
                itemStyle={{ color: "hsl(var(--foreground))" }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke={PRIMARY}
                strokeWidth={2.5}
                fill="url(#sessions-area)"
              />
            </AreaChart>
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
        last 14d
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

function EmptyState(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No session data yet.
    </div>
  );
}

export const SessionsChart = memo(SessionsChartImpl);
