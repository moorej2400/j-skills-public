import { useEffect } from "react";
import { AgentRoster } from "@/components/session/AgentRoster";
import { AgentDetailPanel } from "@/components/session/AgentDetailPanel";
import type { SessionDetail } from "@/lib/types";
import type { SessionSection } from "@/lib/sessionSection";

type Props = {
  sessionId: string;
  detail: SessionDetail;
  agentParam: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onGoToSection: (section: SessionSection, agentId: string | null) => void;
};

export function AgentsSection({
  sessionId,
  detail,
  agentParam,
  onSelectAgent,
  onGoToSection,
}: Props): JSX.Element {
  // Default to the first busy agent (or first agent overall) when no `?agent=`
  // is present, so the right pane shows something useful on first visit.
  useEffect(() => {
    if (agentParam) return;
    const busy = detail.agents.find((a) => a.status.state === "busy");
    const first = busy ?? detail.agents[0];
    if (first) onSelectAgent(first.agentId);
    // run when the agent list changes
  }, [agentParam, detail.agents, onSelectAgent]);

  const selected = agentParam ? detail.agents.find((a) => a.agentId === agentParam) ?? null : null;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[18rem_1fr] md:items-start">
      <div className="md:max-h-[calc(100dvh-13rem)] md:overflow-hidden">
        <AgentRoster agents={detail.agents} onSelect={onSelectAgent} />
      </div>
      <div className="min-h-[480px] rounded-lg border border-border-subtle bg-card/40">
        {selected ? (
          <AgentDetailPanel
            sessionId={sessionId}
            agent={selected}
            workItems={detail.workItems}
            phases={detail.phases}
            onGoToTerminal={() => onGoToSection("terminal", selected.agentId)}
            onGoToKanban={() => onGoToSection("kanban", selected.agentId)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Pick an agent from the roster.
          </div>
        )}
      </div>
    </div>
  );
}
