import { memo, useMemo } from "react";
import type { Agent, Checkpoint, Result } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { aliasColor, aliasBg } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { Flag } from "lucide-react";

type Props = {
  results: Result[];
  checkpoints: Checkpoint[];
  agents: Agent[];
};

type Row =
  | { kind: "result"; createdAt: string; data: Result }
  | { kind: "checkpoint"; createdAt: string; data: Checkpoint };

function ResultsAndCheckpointsImpl({ results, checkpoints, agents }: Props): JSX.Element {
  const nowMs = useNow();
  const aliasFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.agentId, a.alias);
    return map;
  }, [agents]);

  const rows: Row[] = useMemo(() => {
    const r: Row[] = [
      ...results.map((d) => ({ kind: "result" as const, createdAt: d.createdAt, data: d })),
      ...checkpoints.map((d) => ({ kind: "checkpoint" as const, createdAt: d.createdAt, data: d })),
    ];
    r.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return r;
  }, [results, checkpoints]);

  if (rows.length === 0) {
    return (
      <div className="text-center text-xs text-muted-foreground py-12">
        no results or checkpoints yet
      </div>
    );
  }

  // Explicit timeline rail (review M24 UX): a 1px vertical line at x=20px
  // runs through every row, with a small filled circle for results and a
  // hollow + flag glyph for checkpoints. The previous alternating left
  // border pattern read like a syntax-highlighted code block.
  return (
    <ScrollArea className="max-h-[520px]">
      <div className="relative pl-10 pr-3 py-2">
        {/* Rail line */}
        <div
          aria-hidden
          className="absolute left-[20px] top-0 bottom-0 w-px bg-border-subtle"
        />
        <div className="flex flex-col gap-3">
          {rows.map((row) => {
            if (row.kind === "result") {
              const r = row.data;
              const alias = aliasFor.get(r.agentId) ?? r.agentId;
              return (
                <div key={`r-${r.id}`} className="relative">
                  {/* Filled circle node */}
                  <span
                    aria-hidden
                    className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full bg-status-success ring-2 ring-background"
                  />
                  <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                    <span
                      className="rounded px-1.5 py-px text-[10px] font-medium"
                      style={{ color: aliasColor(alias), backgroundColor: aliasBg(alias, 0.12) }}
                    >
                      {alias}
                    </span>
                    {r.commitSha && (
                      <Badge variant="outline" className="px-1.5 py-0 text-2xs font-mono">
                        {r.commitSha.slice(0, 7)}
                      </Badge>
                    )}
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {relativeTime(r.createdAt, nowMs)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] leading-snug text-foreground/95">
                    {r.summary}
                  </div>
                </div>
              );
            }
            const c = row.data;
            return (
              <div key={`c-${c.id}`} className="relative">
                {/* Hollow node + flag glyph */}
                <span
                  aria-hidden
                  className="absolute -left-[28px] top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-primary bg-background ring-2 ring-background"
                >
                  <Flag className="h-2 w-2 text-primary" />
                </span>
                <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                  <Badge variant="secondary" className="px-1.5 py-0 text-2xs uppercase tracking-wider">
                    checkpoint
                  </Badge>
                  {c.mergeCommitSha && (
                    <Badge variant="outline" className="px-1.5 py-0 text-2xs font-mono">
                      {c.mergeCommitSha.slice(0, 7)}
                    </Badge>
                  )}
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {relativeTime(c.createdAt, nowMs)}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-foreground/95 font-medium">
                  {c.summary}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}

export const ResultsAndCheckpoints = memo(ResultsAndCheckpointsImpl);
