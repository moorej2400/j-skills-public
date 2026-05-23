import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";
import type { Assignment, AssignmentStatus } from "@/lib/types";
import { Layers } from "lucide-react";

type Props = {
  assignments: Assignment[];
  selected: string | null;
  onSelect: (phase: string | null) => void;
};

const STATUS_TONE: Record<AssignmentStatus, string> = {
  assigned: "bg-status-idle",
  in_progress: "bg-status-busy",
  blocked: "bg-status-blocked",
  done: "bg-status-success",
  canceled: "bg-status-stopped/60",
};

// Vertical list of pill rows replaces the previous 2-col tile grid
// (review H14 UX). Each row shows the phase name, count, and a tiny
// mini-bar of statuses inside the phase. Selected row gets a left accent
// rule so it reads as a filter list, not a grid of cards.
export function PhaseColumns({ assignments, selected, onSelect }: Props): JSX.Element {
  const counts = new Map<string, number>();
  const statusByPhase = new Map<string, Map<AssignmentStatus, number>>();
  for (const a of assignments) {
    const phase = a.phase || "unphased";
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
    const sub = statusByPhase.get(phase) ?? new Map();
    sub.set(a.status, (sub.get(a.status) ?? 0) + 1);
    statusByPhase.set(phase, sub);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <SectionLabel>
            <Layers className="size-3" />
            phases
          </SectionLabel>
          {selected && (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground">no assignments yet</div>
        ) : (
          <div className="flex flex-col gap-1">
            {entries.map(([phase, count]) => {
              const active = selected === phase;
              const sub = statusByPhase.get(phase) ?? new Map();
              return (
                <button
                  key={phase}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(active ? null : phase)}
                  className={cn(
                    "group flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                    "hover:bg-muted/40",
                    active
                      ? "border-l-2 border-l-primary border-border bg-primary/10 text-foreground"
                      : "border-border-subtle bg-muted/20 text-muted-foreground",
                  )}
                >
                  {/* Phase name in sans (review M14) — it's a noun phrase. */}
                  <span className="flex-1 truncate text-[12px]">{phase}</span>
                  {/* Mini status bar: per-status segment widths reflect the
                      assignment count in this phase. */}
                  <span className="flex h-1 w-12 overflow-hidden rounded-full bg-muted/60" aria-hidden>
                    {([
                      "in_progress",
                      "blocked",
                      "done",
                      "assigned",
                      "canceled",
                    ] as AssignmentStatus[]).map((s) => {
                      const c = sub.get(s) ?? 0;
                      if (c === 0) return null;
                      return (
                        <span
                          key={s}
                          className={STATUS_TONE[s]}
                          style={{ width: `${(c / count) * 100}%` }}
                        />
                      );
                    })}
                  </span>
                  <span className="tabular-nums text-2xs text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
