import { cn } from "@/lib/utils";
import type { Agent, AgentStatusState } from "@/lib/types";

const STATE_LABEL: Record<AgentStatusState, string> = {
  busy: "Busy",
  idle: "Idle",
  stopped: "Stopped",
};

// Color-blind safe encoding: each status uses a *shape* differentiator on top
// of color (review C1 UX). `busy` = filled circle with a subtle pulse ring,
// `idle` = open ring (border only), `stopped` = filled muted with a diagonal
// slash. Drops the previous `ring-1 ring-border/60` (M28) which read as
// fuzzy at standard viewing distance. Aria-label is the source of truth for
// screen readers.
function Dot({ state, alias }: { state: AgentStatusState; alias: string }): JSX.Element {
  const label = `${alias}: ${STATE_LABEL[state]}`;
  if (state === "busy") {
    return (
      <span
        aria-label={label}
        className="relative inline-flex h-2.5 w-2.5 items-center justify-center transition-transform hover:scale-125"
      >
        <span className="absolute inset-0 rounded-full bg-status-busy/60 animate-ping" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-status-busy" />
      </span>
    );
  }
  if (state === "idle") {
    return (
      <span
        aria-label={label}
        className="inline-block h-2.5 w-2.5 rounded-full border border-status-idle bg-transparent transition-transform hover:scale-125"
      />
    );
  }
  // stopped — filled muted with a diagonal slash via inline SVG so the
  // glyph reads even when the dot is just 10px wide.
  return (
    <span
      aria-label={label}
      className="relative inline-block h-2.5 w-2.5 rounded-full bg-status-stopped/80 transition-transform hover:scale-125"
    >
      <svg
        viewBox="0 0 10 10"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <line x1="1" y1="9" x2="9" y2="1" stroke="hsl(var(--background))" strokeWidth="1.5" />
      </svg>
    </span>
  );
}

export function AgentDots({
  agents,
  max = 8,
  className,
}: {
  agents: Agent[];
  max?: number;
  className?: string;
}): JSX.Element {
  const visible = agents.slice(0, max);
  const overflow = agents.length - visible.length;
  return (
    <div className={cn("flex min-w-0 max-w-full flex-wrap items-center gap-1.5", className)}>
      {visible.map((agent) => (
        <Dot key={agent.agentId} state={agent.status.state} alias={agent.alias} />
      ))}
      {overflow > 0 ? (
        <span className="ml-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
