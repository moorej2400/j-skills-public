import { motion } from "framer-motion";
import type { Agent } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { aliasColor } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useHoverAgent } from "./HoverAgentContext";
import { useNow } from "@/lib/useNow";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { cn } from "@/lib/utils";
import { Cpu, FolderGit2, Activity } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Props = {
  agent: Agent;
  index: number;
  onSelect?: (agentId: string) => void;
  // Roving-tabindex hooks — when AgentRoster runs the j/k navigation, it
  // owns the focus order and overrides the default `tabIndex={onSelect ? 0
  // : undefined}` so only one card is in the tab sequence at a time.
  tabIndex?: number;
  cardRef?: (el: HTMLDivElement | null) => void;
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
};

// Status pill tones backed by the new `--status-*` tokens (review H1 UX).
// Replaces the previous raw `emerald/sky/zinc` palette so the agent card,
// roster bar, dots, viz spheres, and assignments board all share the same
// semantic palette.
const statusPillStyles: Record<Agent["status"]["state"], string> = {
  busy: "bg-status-busy/15 text-status-busy border-status-busy/30",
  idle: "bg-status-idle/10 text-status-idle border-status-idle/25",
  stopped: "bg-status-stopped/15 text-status-stopped border-status-stopped/30",
};

export function AgentCard({
  agent,
  index,
  onSelect,
  tabIndex,
  cardRef,
  onFocus,
}: Props): JSX.Element {
  const nowMs = useNow();
  const reduced = useReducedMotion();
  const { hoveredAgentId, setHoveredAgent } = useHoverAgent();
  const isHovered = hoveredAgentId === agent.agentId;
  const setHovered = setHoveredAgent;
  const accent = aliasColor(agent.alias);

  return (
    <motion.div
      layout
      // Reduced motion: skip the 6px slide-in entrance — opacity-only.
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.4), duration: 0.18 }}
      onMouseEnter={() => setHovered(agent.agentId)}
      onMouseLeave={() => setHovered(null)}
      onClick={onSelect ? () => onSelect(agent.agentId) : undefined}
      onKeyDown={
        onSelect
          ? (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(agent.agentId);
              }
            }
          : undefined
      }
      role={onSelect ? "button" : undefined}
      tabIndex={tabIndex !== undefined ? tabIndex : onSelect ? 0 : undefined}
      ref={cardRef}
      onFocus={onFocus}
      className={cn(
        "rounded-lg border border-border bg-card px-3 py-2.5 transition-shadow",
        "hover:border-primary/40",
        onSelect && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isHovered && "border-primary/60 shadow-[0_0_0_1px_hsl(var(--primary)/0.5)]",
      )}
      // box-shadow `inset` respects the rounded radius — the previous
      // `borderLeft` 2px style clipped the top-left corner (review M17).
      style={{ boxShadow: `inset 2px 0 0 0 ${accent}` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* Alias is a human name — render in sans (review H5). */}
          <div
            className="text-[13px] font-semibold leading-tight truncate"
            style={{ color: accent }}
            title={agent.alias}
          >
            {agent.alias}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{agent.specialty}</div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-medium uppercase tracking-wide",
            statusPillStyles[agent.status.state],
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              agent.status.state === "busy" && "bg-status-busy animate-pulse",
              agent.status.state === "idle" && "bg-status-idle",
              agent.status.state === "stopped" && "bg-status-stopped",
              reduced && "animate-none",
            )}
          />
          {agent.status.state}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {/* cli + model are identifiers — keep mono (review H5). */}
        <Badge variant="outline" className="px-1.5 py-0 text-2xs font-mono lowercase">
          <Cpu className="size-2.5 mr-1" />
          {agent.cli}
        </Badge>
        <Badge variant="outline" className="px-1.5 py-0 text-2xs font-mono lowercase truncate max-w-[140px]">
          {agent.model}
        </Badge>
        {/* Worktree path collapses into a folder icon with tooltip rather
            than consuming a full row of cramped 9.5px text (review M16). */}
        {agent.runtime?.worktreePath && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center rounded border border-border px-1.5 py-0 text-muted-foreground hover:text-foreground transition-colors cursor-help">
                <FolderGit2 className="size-2.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="font-mono text-2xs max-w-[320px] break-all">
              {agent.runtime.worktreePath}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {/* Relative time in sans tabular-nums — not a code-ish identifier. */}
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Activity className="size-2.5" />
          {relativeTime(agent.heartbeat?.updatedAt ?? agent.status.updatedAt, nowMs)}
        </span>
        {agent.status.summary && (
          <span className="truncate text-foreground/70 italic" title={agent.status.summary}>
            {agent.status.summary}
          </span>
        )}
      </div>
    </motion.div>
  );
}
