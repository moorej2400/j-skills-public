import { KanbanBoard } from "@/components/session/KanbanBoard";
import type { SessionDetail } from "@/lib/types";

type Props = {
  detail: SessionDetail;
  agentParam: string | null;
  onSelectAgent: (agentId: string | null) => void;
};

export function KanbanSection({ detail, agentParam, onSelectAgent }: Props): JSX.Element {
  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[480px] flex-col">
      <KanbanBoard
        workItems={detail.workItems}
        agents={detail.agents}
        phases={detail.phases}
        results={detail.results}
        agentFilter={agentParam}
        onSelectAgent={onSelectAgent}
      />
    </div>
  );
}
