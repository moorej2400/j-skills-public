import { SessionTimeline } from "@/components/session/SessionTimeline";
import type { Message, SessionDetail } from "@/lib/types";

type Props = { detail: SessionDetail; messages: Message[] };

export function TimelineSection({ detail, messages }: Props): JSX.Element {
  return (
    <div className="h-[calc(100dvh-13rem)] min-h-[480px] overflow-hidden rounded-lg border border-border-subtle bg-card/40">
      <SessionTimeline
        messages={messages}
        assignments={detail.assignments}
        results={detail.results}
        checkpoints={detail.checkpoints}
        agents={detail.agents}
      />
    </div>
  );
}
