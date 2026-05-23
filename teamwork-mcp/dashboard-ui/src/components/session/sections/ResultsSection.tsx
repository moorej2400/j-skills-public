import { ResultsAndCheckpoints } from "@/components/session/ResultsAndCheckpoints";
import type { SessionDetail } from "@/lib/types";

type Props = { detail: SessionDetail };

export function ResultsSection({ detail }: Props): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-card/40">
      <ResultsAndCheckpoints
        results={detail.results}
        checkpoints={detail.checkpoints}
        agents={detail.agents}
      />
    </div>
  );
}
