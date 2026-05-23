import { useSessionStore } from "@/store/sessionStore";
import type { AgentStatusState } from "@/lib/types";
import { isParentAgent } from "./viz-helpers";

// Static SVG fallback for the 3D agent network. Renders a concentric ring of
// dots colored by status — no R3F, no controls, no WebGL — so phones don't
// pay the battery + gesture-capture cost (review M30 UX). Pairs with a
// "View 3D" button in SessionPage that lets the user opt into the canvas.
export function AgentMapSvg({ sessionId }: { sessionId: string }): JSX.Element {
  const detail = useSessionStore((s) => s.details[sessionId]);
  const agents = detail?.agents ?? [];
  const parent = agents.find((a) => isParentAgent(a.agentId, a.alias));
  const workers = agents.filter((a) => a !== parent);

  const VB = 240;
  const cx = VB / 2;
  const cy = VB / 2;
  const radius = 80;

  const dotColor = (state: AgentStatusState): string => {
    if (state === "busy") return "hsl(var(--status-busy))";
    if (state === "stopped") return "hsl(var(--status-stopped))";
    return "hsl(var(--status-idle))";
  };

  return (
    <div className="flex h-full w-full items-center justify-center">
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        className="h-full w-full max-h-[60dvh]"
        role="img"
        aria-label={`Agent map: ${agents.length} agents`}
      >
        {/* Faint ring as scaffolding. */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="hsl(var(--border-subtle))"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
        {workers.map((w, i) => {
          const angle = (i / Math.max(1, workers.length)) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          return (
            <g key={w.agentId}>
              <line
                x1={cx}
                y1={cy}
                x2={x}
                y2={y}
                stroke="hsl(var(--border-subtle))"
                strokeWidth={1}
              />
              <circle cx={x} cy={y} r={6} fill={dotColor(w.status.state)} />
              <text
                x={x}
                y={y + 18}
                textAnchor="middle"
                fontSize={9}
                fill="hsl(var(--muted-foreground))"
                fontFamily="Inter, sans-serif"
              >
                {w.alias}
              </text>
            </g>
          );
        })}
        {parent ? (
          <>
            <circle cx={cx} cy={cy} r={9} fill="hsl(var(--primary))" />
            <text
              x={cx}
              y={cy + 22}
              textAnchor="middle"
              fontSize={10}
              fill="hsl(var(--foreground))"
              fontFamily="Inter, sans-serif"
              fontWeight={600}
            >
              {parent.alias}
            </text>
          </>
        ) : null}
      </svg>
    </div>
  );
}
