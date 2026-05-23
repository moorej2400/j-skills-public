import { KanbanSquare, Terminal as TerminalIcon } from "lucide-react";
import type { Agent, PhaseBoundary, WorkItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { aliasColor } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { STATUS_LABEL, phaseLabel } from "@/lib/workItems";

type Props = {
  sessionId: string;
  agent: Agent;
  workItems: WorkItem[];
  phases: PhaseBoundary[];
  onGoToTerminal: () => void;
  onGoToKanban: () => void;
};

const statusPillStyles: Record<Agent["status"]["state"], string> = {
  busy: "bg-status-busy/15 text-status-busy border-status-busy/30",
  idle: "bg-status-idle/10 text-status-idle border-status-idle/25",
  stopped: "bg-status-stopped/15 text-status-stopped border-status-stopped/30",
};

export function AgentDetailPanel({
  agent,
  workItems,
  phases,
  onGoToTerminal,
  onGoToKanban,
}: Props): JSX.Element {
  const nowMs = useNow();
  const accent = aliasColor(agent.alias);
  const r = agent.runtime;
  const ownItems = workItems.filter(
    (w) =>
      w.assigneeAgentIds.includes(agent.agentId) ||
      w.ownerAgentId === agent.agentId ||
      w.primaryAssigneeAgentId === agent.agentId,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
        <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
        <h2 className="truncate text-sm font-semibold" style={{ color: accent }}>
          {agent.alias}
        </h2>
        <Badge variant="outline" className="py-0 text-2xs uppercase tracking-wider">
          {agent.specialty || "worker"}
        </Badge>
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
            )}
          />
          {agent.status.state}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onGoToTerminal}
            className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-card-elevated px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <TerminalIcon className="size-3" />
            Terminal
          </button>
          <button
            type="button"
            onClick={onGoToKanban}
            className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-card-elevated px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <KanbanSquare className="size-3" />
            Work items
          </button>
        </div>
      </header>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          <div className="rounded-md border bg-card-elevated p-3">
            <div className="text-xs font-semibold text-foreground">
              {agent.status.state}
              {agent.status.summary ? (
                <span className="font-normal text-muted-foreground"> — {agent.status.summary}</span>
              ) : null}
            </div>
            <div className="mt-1 text-2xs text-muted-foreground">
              updated {relativeTime(agent.status.updatedAt, nowMs)}
            </div>
          </div>

          <div>
            <div className="mb-2 text-2xs uppercase tracking-wider text-muted-foreground">Runtime</div>
            <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 rounded-md border bg-card-elevated px-3 py-2 text-xs">
              <Cell label="CLI" value={agent.cli} />
              <Cell label="Model" value={<span className="font-mono">{agent.model}</span>} />
              {agent.reasoningEffort ? <Cell label="Reasoning" value={agent.reasoningEffort} /> : null}
              {r?.worktreePath ? (
                <Cell label="Worktree" value={<span className="font-mono break-all">{r.worktreePath}</span>} />
              ) : null}
              {r?.lifecycleState ? <Cell label="Lifecycle" value={r.lifecycleState} /> : null}
              {r?.startedAt ? <Cell label="Started" value={relativeTime(r.startedAt, nowMs)} /> : null}
              {r?.exitedAt ? (
                <Cell label="Exited" value={`${relativeTime(r.exitedAt, nowMs)} (code ${r.exitCode ?? "?"})`} />
              ) : null}
              <Cell label="Created" value={relativeTime(agent.createdAt, nowMs)} />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground">
                Assigned work items
              </div>
              <span className="text-2xs tabular-nums text-muted-foreground">{ownItems.length}</span>
            </div>
            {ownItems.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-subtle px-3 py-2 text-xs text-muted-foreground">
                No work items assigned.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {ownItems.map((wi) => (
                  <li
                    key={wi.workItemId}
                    className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-2"
                  >
                    <div className="text-[12px] font-medium text-foreground/95">{wi.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="px-1.5 py-0 text-2xs">
                        {STATUS_LABEL[wi.status]}
                      </Badge>
                      <span>{phaseLabel(wi.phaseNumber, phases)}</span>
                      <span className="tabular-nums">{relativeTime(wi.updatedAt, nowMs)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <>
      <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xs text-foreground break-all">{value}</div>
    </>
  );
}
