import { useMemo } from "react";
import type { Agent, Assignment, AssignmentStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { aliasBg, aliasColor } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";

type Props = {
  assignments: Assignment[];
  agents: Agent[];
  phaseFilter: string | null;
};

// Column header tones use the new --status-* tokens (review H1).
const COLUMNS: Array<{ key: AssignmentStatus; label: string; tone: string }> = [
  { key: "assigned", label: "Assigned / Queued", tone: "text-muted-foreground" },
  { key: "in_progress", label: "Working", tone: "text-status-busy" },
  { key: "blocked", label: "Blocked", tone: "text-status-blocked" },
  { key: "done", label: "Done", tone: "text-status-success" },
  { key: "canceled", label: "Canceled", tone: "text-status-stopped/70" },
];

export function AssignmentsBoard({ assignments, agents, phaseFilter }: Props): JSX.Element {
  const nowMs = useNow();
  const aliasFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.agentId, a.alias);
    return map;
  }, [agents]);

  const filtered = phaseFilter
    ? assignments.filter((a) => (a.phase || "unphased") === phaseFilter)
    : assignments;

  return (
    // Auto-fit grid replaces the brittle 1/2/5 breakpoints (review H13).
    // Columns wrap based on container width with a 220px floor.
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      {COLUMNS.map((col) => {
        const items = filtered.filter((a) => a.status === col.key);
        return (
          <div
            key={col.key}
            className="rounded-lg border border-border-subtle bg-card/40 flex flex-col min-h-[140px]"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
              <div className={cn("text-2xs font-semibold uppercase tracking-wider", col.tone)}>
                {col.label}
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {items.length}
              </span>
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="flex flex-col gap-2 p-2">
                {items.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/60 italic px-1 py-2">empty</div>
                ) : (
                  items.map((a) => {
                    const alias = aliasFor.get(a.agentId) ?? a.agentId;
                    return (
                      <div
                        key={a.id}
                        className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-2 hover:border-primary/40 transition-colors"
                      >
                        {/* Summary-first hierarchy (review M23): the
                            assignment text leads, with the meta row
                            (assignee + age + phase) demoted to a compact
                            muted footer. Phase pill in sans (review M14). */}
                        <div className="text-[12px] leading-snug text-foreground/95 line-clamp-2">
                          {a.summary}
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px] text-muted-foreground">
                          <span
                            className="rounded px-1.5 py-px text-[10px] font-medium"
                            style={{ color: aliasColor(alias), backgroundColor: aliasBg(alias, 0.12) }}
                          >
                            {alias}
                          </span>
                          <span className="tabular-nums">
                            {relativeTime(a.updatedAt ?? a.createdAt, nowMs)}
                          </span>
                          {a.activeClaims?.length ? (
                            <span className="text-status-busy">
                              {a.activeClaims.map((claim) => claim.agentAlias).join(", ")} claimed
                            </span>
                          ) : null}
                          <Badge
                            variant="outline"
                            className="ml-auto px-1.5 py-0 text-2xs"
                            title={a.phase}
                          >
                            {a.phase || "unphased"}
                          </Badge>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}
