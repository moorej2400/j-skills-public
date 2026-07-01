import type { PhaseBoundary, WorkItem, WorkItemStatus } from "@/lib/types";

// Operator-facing labels (PRD §"Current Backend Fit"). The raw status names
// describe lifecycle; column headers describe operator-visible state.
export const STATUS_LABEL: Record<WorkItemStatus, string> = {
  planned: "Backlog",
  assigned: "Queued",
  "in-progress": "Working",
  blocked: "Blocked",
  done: "Finished",
  canceled: "Canceled",
};

// Column order from PRD §"Kanban View". Canceled is intentionally last and is
// hidden by default behind a filter toggle.
export const KANBAN_COLUMNS: readonly WorkItemStatus[] = [
  "planned",
  "assigned",
  "in-progress",
  "blocked",
  "done",
  "canceled",
];

// Status tone — re-uses existing --status-* tailwind tokens so the kanban
// reads consistently with the roster and breadcrumb pips.
export const STATUS_TONE: Record<WorkItemStatus, string> = {
  planned: "text-muted-foreground",
  assigned: "text-status-idle",
  "in-progress": "text-status-busy",
  blocked: "text-status-blocked",
  done: "text-status-success",
  canceled: "text-status-stopped/70",
};

export const STATUS_DOT_BG: Record<WorkItemStatus, string> = {
  planned: "bg-muted-foreground",
  assigned: "bg-status-idle",
  "in-progress": "bg-status-busy",
  blocked: "bg-status-blocked",
  done: "bg-status-success",
  canceled: "bg-status-stopped/60",
};

export type KanbanFilters = {
  phaseNumber: number | null;
  agentId: string | null;
  query: string;
  hideFinished: boolean;
  showCanceled: boolean;
};

export const EMPTY_FILTERS: KanbanFilters = {
  phaseNumber: null,
  agentId: null,
  query: "",
  hideFinished: false,
  showCanceled: false,
};

export function filterWorkItems(items: WorkItem[], filters: KanbanFilters): WorkItem[] {
  const q = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.phaseNumber !== null && item.phaseNumber !== filters.phaseNumber) return false;
    if (filters.agentId) {
      const inAssignees = item.assigneeAgentIds.includes(filters.agentId);
      const isOwner = item.ownerAgentId === filters.agentId;
      if (!inAssignees && !isOwner) return false;
    }
    if (filters.hideFinished && item.status === "done") return false;
    if (!filters.showCanceled && item.status === "canceled") return false;
    if (q) {
      const hay = `${item.title} ${item.description} ${item.assigneeAliases.join(" ")} ${item.ownerAlias ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function groupByStatus(items: WorkItem[]): Record<WorkItemStatus, WorkItem[]> {
  const out: Record<WorkItemStatus, WorkItem[]> = {
    planned: [],
    assigned: [],
    "in-progress": [],
    blocked: [],
    done: [],
    canceled: [],
  };
  for (const item of items) out[item.status].push(item);
  for (const key of Object.keys(out) as WorkItemStatus[]) {
    // Older API payloads may omit timestamps; fall back so sorting never throws.
    out[key].sort((a, b) =>
      (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""),
    );
  }
  return out;
}

// PRD §"Open Questions" — phase displayed as `phase-N · title` when available.
export function phaseLabel(phaseNumber: number, phases: PhaseBoundary[]): string {
  const match = phases.find((p) => p.phaseNumber === phaseNumber);
  if (match?.title) return `phase-${phaseNumber} · ${match.title}`;
  return `phase-${phaseNumber}`;
}

export function uniquePhaseNumbers(items: WorkItem[]): number[] {
  const set = new Set<number>();
  for (const item of items) set.add(item.phaseNumber);
  return [...set].sort((a, b) => a - b);
}
