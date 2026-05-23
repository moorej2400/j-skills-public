import { useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/useReducedMotion";

const BUCKETS = 12;
const BUCKET_MS = (60 * 60 * 1000) / BUCKETS;
const WIDTH = 80;
const HEIGHT = 24;

/**
 * Tiny inline sparkline of message activity over the last hour. Now animates
 * the path on update via framer-motion and renders a small "ping" dot at the
 * right edge when a brand-new timestamp lands (review H9 UX). aria-label
 * carries the count so screen readers see "Last hour: N messages" instead of
 * a decorative `aria-hidden` SVG (review M29 UX).
 */
export function MessageSparkline({
  timestamps,
  className,
}: {
  timestamps: string[];
  className?: string;
}): JSX.Element {
  const reduced = useReducedMotion();
  const lastCountRef = useRef<number>(timestamps.length);
  const isNew = timestamps.length > lastCountRef.current;
  lastCountRef.current = timestamps.length;

  const { linePath, areaPath, hasData, lastPoint, totalCount } = useMemo(() => {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const buckets = new Array<number>(BUCKETS).fill(0);
    let total = 0;
    for (const iso of timestamps) {
      const t = Date.parse(iso);
      if (Number.isNaN(t) || t < windowStart || t > now) continue;
      const idx = Math.min(BUCKETS - 1, Math.floor((t - windowStart) / BUCKET_MS));
      buckets[idx] += 1;
      total += 1;
    }
    const max = Math.max(1, ...buckets);
    const stepX = WIDTH / Math.max(1, BUCKETS - 1);
    const points = buckets.map((count, i) => {
      const x = i * stepX;
      const y = HEIGHT - 2 - (count / max) * (HEIGHT - 4);
      return [x, y] as const;
    });
    const linePath = points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const areaPath = `${linePath} L${WIDTH.toFixed(1)},${HEIGHT} L0,${HEIGHT} Z`;
    return {
      linePath,
      areaPath,
      hasData: buckets.some((b) => b > 0),
      lastPoint: points[points.length - 1],
      totalCount: total,
    };
  }, [timestamps]);

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={`Last hour: ${totalCount} ${totalCount === 1 ? "message" : "messages"}`}
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
        </linearGradient>
      </defs>
      {hasData ? (
        <>
          <motion.path
            d={areaPath}
            fill="url(#spark-fill)"
            initial={false}
            animate={{ d: areaPath }}
            transition={reduced ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
          />
          <motion.path
            d={linePath}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            initial={false}
            animate={{ d: linePath }}
            transition={reduced ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
          />
          {lastPoint && isNew && !reduced ? (
            <motion.circle
              cx={lastPoint[0]}
              cy={lastPoint[1]}
              r={2}
              fill="hsl(var(--primary))"
              initial={{ opacity: 1, scale: 0.6 }}
              animate={{ opacity: 0, scale: 3 }}
              transition={{ duration: 0.9, ease: "easeOut" }}
            />
          ) : null}
        </>
      ) : (
        <line
          x1={0}
          y1={HEIGHT - 2}
          x2={WIDTH}
          y2={HEIGHT - 2}
          stroke="hsl(var(--muted-foreground))"
          strokeOpacity={0.35}
          strokeDasharray="2 3"
          strokeWidth={1}
        />
      )}
    </svg>
  );
}
