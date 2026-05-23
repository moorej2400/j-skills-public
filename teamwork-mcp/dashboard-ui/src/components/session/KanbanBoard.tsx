import { useMemo, useState } from "react";
import { Check, GitBranch, Link2, Search, X } from "lucide-react";
import type { Agent, PhaseBoundary, Result, WorkItem, WorkItemStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { aliasBg, aliasColor } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import {
  EMPTY_FILTERS,
  KANBAN_COLUMNS,
  STATUS_LABEL,
  STATUS_TONE,
  filterWorkItems,
  groupByStatus,
  phaseLabel,
  uniquePhaseNumbers,
  type KanbanFilters,
} from "@/lib/workItems";

type Props = {
  workItems: WorkItem[];
  agents: Agent[];
  phases: PhaseBoundary[];
  results: Result[];
  agentFilter: string | null;
  onSelectAgent: (agentId: string | null) => void;
};

export function KanbanBoard({
  workItems,
  agents,
  phases,
  results,
  agentFilter,
  onSelectAgent,
}: Props): JSX.Element {
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);

  const effectiveFilters = useMemo<KanbanFilters>(
    () => ({ ...filters, agentId: agentFilter ?? filters.agentId }),
    [filters, agentFilter],
  );

  const filtered = useMemo(() => filterWorkItems(workItems, effectiveFilters), [workItems, effectiveFilters]);
  const grouped = useMemo(() => groupByStatus(filtered), [filtered]);
  const phaseNumbers = useMemo(() => uniquePhaseNumbers(workItems), [workItems]);
  const resultsByWorkItem = useMemo(() => {
    // The `Result` shape in the dashboard wire today doesn't include
    // `workItemId` directly — we keep a best-effort lookup for when it does.
    const map = new Map<string, Result[]>();
    for (const r of results) {
      const wid = (r as unknown as { workItemId?: string }).workItemId;
      if (!wid) continue;
      const list = map.get(wid) ?? [];
      list.push(r);
      map.set(wid, list);
    }
    return map;
  }, [results]);

  const visibleColumns = useMemo(() => {
    return KANBAN_COLUMNS.filter((status) => {
      if (status === "canceled" && !effectiveFilters.showCanceled) return false;
      if (status === "done" && effectiveFilters.hideFinished) return false;
      return true;
    });
  }, [effectiveFilters.showCanceled, effectiveFilters.hideFinished]);

  const hasAnyItems = workItems.length > 0;
  const hasFilteredItems = filtered.length > 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <KanbanFiltersBar
        filters={filters}
        agentFilter={agentFilter}
        agents={agents}
        phases={phases}
        phaseNumbers={phaseNumbers}
        onChange={setFilters}
        onClearAgent={() => onSelectAgent(null)}
      />

      {!hasAnyItems ? (
        <EmptyState
          title="No work items yet"
          hint="The parent agent hasn't created any work items for this session."
        />
      ) : !hasFilteredItems ? (
        <EmptyState
          title="No items match your filters"
          hint="Clear filters above to see everything."
          action={
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                onSelectAgent(null);
              }}
              className="rounded-md border border-border-subtle px-2.5 py-1 text-xs hover:text-foreground"
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full gap-3 pr-2 min-w-max">
            {visibleColumns.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                items={grouped[status]}
                phases={phases}
                resultsByWorkItem={resultsByWorkItem}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KanbanColumn({
  status,
  items,
  phases,
  resultsByWorkItem,
}: {
  status: WorkItemStatus;
  items: WorkItem[];
  phases: PhaseBoundary[];
  resultsByWorkItem: Map<string, Result[]>;
}): JSX.Element {
  return (
    <section
      className="flex w-[280px] shrink-0 flex-col rounded-lg border border-border-subtle bg-card/40"
      aria-label={STATUS_LABEL[status]}
    >
      <header className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className={cn("text-2xs font-semibold uppercase tracking-wider", STATUS_TONE[status])}>
          {STATUS_LABEL[status]}
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
      </header>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-2">
          {items.length === 0 ? (
            <div className="px-1 py-2 text-[11px] italic text-muted-foreground/60">empty</div>
          ) : (
            items.map((item) => (
              <KanbanCard
                key={item.workItemId}
                item={item}
                phases={phases}
                hasResult={(resultsByWorkItem.get(item.workItemId)?.length ?? 0) > 0}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

function KanbanCard({
  item,
  phases,
  hasResult,
}: {
  item: WorkItem;
  phases: PhaseBoundary[];
  hasResult: boolean;
}): JSX.Element {
  const nowMs = useNow();
  const alias =
    item.assigneeAliases[0] ?? item.ownerAlias ?? "unassigned";
  const phase = phaseLabel(item.phaseNumber, phases);
  const dependencyCount = item.dependsOnIds.length;
  const hasAcceptance = !!item.acceptanceCriteria;

  return (
    <article className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-2 transition-colors hover:border-primary/40">
      <div className="text-[12px] font-medium leading-snug text-foreground/95 line-clamp-2">
        {item.title}
      </div>
      {item.description ? (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground line-clamp-1">
          {item.description}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          className="rounded px-1.5 py-px text-[10px] font-medium"
          style={{ color: aliasColor(alias), backgroundColor: aliasBg(alias, 0.12) }}
        >
          {alias}
        </span>
        <span className="tabular-nums">{relativeTime(item.updatedAt, nowMs)}</span>
        {hasAcceptance ? (
          <span
            className="inline-flex items-center gap-0.5 text-status-success"
            title="Has acceptance criteria"
          >
            <Check className="size-3" />
          </span>
        ) : null}
        {hasResult ? (
          <span
            className="inline-flex items-center gap-0.5 text-status-success"
            title="Result recorded"
          >
            <GitBranch className="size-3" />
          </span>
        ) : null}
        {dependencyCount > 0 ? (
          <span
            className="inline-flex items-center gap-0.5 text-status-blocked"
            title={`Depends on ${dependencyCount} item(s)`}
          >
            <Link2 className="size-3" />
            {dependencyCount}
          </span>
        ) : null}
        <Badge variant="outline" className="ml-auto px-1.5 py-0 text-2xs" title={phase}>
          {phase}
        </Badge>
      </div>
    </article>
  );
}

function KanbanFiltersBar({
  filters,
  agentFilter,
  agents,
  phases,
  phaseNumbers,
  onChange,
  onClearAgent,
}: {
  filters: KanbanFilters;
  agentFilter: string | null;
  agents: Agent[];
  phases: PhaseBoundary[];
  phaseNumbers: number[];
  onChange: (next: KanbanFilters) => void;
  onClearAgent: () => void;
}): JSX.Element {
  const agentName = agentFilter
    ? agents.find((a) => a.agentId === agentFilter)?.alias ?? agentFilter.slice(0, 8)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative flex items-center">
        <Search className="absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
        <input
          type="search"
          placeholder="Search work items…"
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          className="h-7 w-48 rounded-md border border-border-subtle bg-background pl-7 pr-2 text-[12px] outline-none focus:border-primary/50"
        />
      </label>

      <select
        value={filters.phaseNumber ?? ""}
        onChange={(e) =>
          onChange({
            ...filters,
            phaseNumber: e.target.value === "" ? null : Number.parseInt(e.target.value, 10),
          })
        }
        className="h-7 rounded-md border border-border-subtle bg-background px-2 text-[12px] outline-none focus:border-primary/50"
      >
        <option value="">All phases</option>
        {phaseNumbers.map((n) => (
          <option key={n} value={n}>
            {phaseLabel(n, phases)}
          </option>
        ))}
      </select>

      <select
        value={filters.agentId ?? ""}
        onChange={(e) =>
          onChange({ ...filters, agentId: e.target.value === "" ? null : e.target.value })
        }
        className="h-7 rounded-md border border-border-subtle bg-background px-2 text-[12px] outline-none focus:border-primary/50"
        disabled={!!agentFilter}
        title={agentFilter ? "Cleared from URL filter" : undefined}
      >
        <option value="">All agents</option>
        {agents
          .filter((a) => a.role !== "parent")
          .map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.alias}
            </option>
          ))}
      </select>

      {agentFilter && agentName ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-px text-2xs text-primary">
          agent: {agentName}
          <button
            type="button"
            onClick={onClearAgent}
            className="inline-flex items-center"
            aria-label="Clear agent filter"
          >
            <X className="size-3" />
          </button>
        </span>
      ) : null}

      <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={filters.hideFinished}
          onChange={(e) => onChange({ ...filters, hideFinished: e.target.checked })}
          className="size-3.5"
        />
        Hide finished
      </label>

      <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={filters.showCanceled}
          onChange={(e) => onChange({ ...filters, showCanceled: e.target.checked })}
          className="size-3.5"
        />
        Show canceled
      </label>
    </div>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle bg-card/30 p-8 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{hint}</div>
      {action}
    </div>
  );
}
