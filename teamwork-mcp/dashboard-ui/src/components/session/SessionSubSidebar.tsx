import { useMemo } from "react";
import {
  Activity,
  KanbanSquare,
  ListTree,
  MessagesSquare,
  Package,
  Terminal as TerminalIcon,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionSection } from "@/lib/sessionSection";
import type { SessionDetail, Message } from "@/lib/types";

type Props = {
  detail: SessionDetail;
  messages: Message[] | undefined;
  active: SessionSection;
  onSelect: (next: SessionSection) => void;
  unread?: Partial<Record<SessionSection, number>>;
};

type Entry = {
  key: SessionSection;
  label: string;
  Icon: typeof Activity;
  count: number;
  tone?: string;
};

const ICON: Record<SessionSection, typeof Activity> = {
  overview: Activity,
  kanban: KanbanSquare,
  messages: MessagesSquare,
  agents: Users,
  terminal: TerminalIcon,
  results: Package,
  timeline: ListTree,
};

const LABEL: Record<SessionSection, string> = {
  overview: "Overview",
  kanban: "Kanban",
  messages: "Messages",
  agents: "Agents",
  terminal: "Terminal",
  results: "Results",
  timeline: "Timeline",
};

export function SessionSubSidebar({ detail, messages, active, onSelect, unread }: Props): JSX.Element {
  const entries = useMemo<Entry[]>(() => {
    const openWork = detail.workItems.filter((w) => w.status !== "done" && w.status !== "canceled").length;
    const busyAgents = detail.agents.filter((a) => a.status.state === "busy").length;
    const runningRuntimes = detail.agents.filter((a) => a.runtime?.lifecycleState === "running").length;
    const messageCount = messages?.length ?? detail.counts.messages;
    const resultsCount = detail.results.length + detail.checkpoints.length;
    const timelineCount =
      (messages?.length ?? 0) + detail.assignments.length + detail.results.length + detail.checkpoints.length;
    return [
      { key: "overview", label: LABEL.overview, Icon: ICON.overview, count: 0 },
      { key: "kanban", label: LABEL.kanban, Icon: ICON.kanban, count: openWork },
      { key: "messages", label: LABEL.messages, Icon: ICON.messages, count: messageCount },
      { key: "agents", label: LABEL.agents, Icon: ICON.agents, count: busyAgents, tone: busyAgents > 0 ? "text-status-busy" : undefined },
      { key: "terminal", label: LABEL.terminal, Icon: ICON.terminal, count: runningRuntimes },
      { key: "results", label: LABEL.results, Icon: ICON.results, count: resultsCount },
      { key: "timeline", label: LABEL.timeline, Icon: ICON.timeline, count: timelineCount },
    ];
  }, [detail, messages]);

  return (
    <>
      {/* Desktop: vertical pill list */}
      <nav aria-label="Session sections" className="hidden md:flex md:flex-col md:gap-1">
        {entries.map(({ key, label, Icon, count, tone }) => {
          const isActive = key === active;
          const u = unread?.[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(key)}
              className={cn(
                "group relative flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                "hover:bg-muted/40",
                isActive
                  ? "border-l-2 border-l-primary border-border bg-primary/10 text-foreground"
                  : "border-border-subtle bg-muted/20 text-muted-foreground",
              )}
            >
              <Icon className={cn("size-3.5 shrink-0", isActive && "text-primary")} />
              <span className="flex-1 truncate text-[12px]">{label}</span>
              {count > 0 ? (
                <span className={cn("tabular-nums text-2xs", tone ?? "text-muted-foreground")}>{count}</span>
              ) : null}
              {u > 0 ? (
                <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary">
                  +{u}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Mobile: horizontal segmented control */}
      <nav aria-label="Session sections" className="md:hidden -mx-1 overflow-x-auto">
        <div className="flex gap-1 px-1">
          {entries.map(({ key, label, Icon, count }) => {
            const isActive = key === active;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isActive}
                onClick={() => onSelect(key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors",
                  isActive
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border-subtle bg-muted/20 text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
                <span>{label}</span>
                {count > 0 ? (
                  <span className="tabular-nums text-2xs text-muted-foreground">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}

export function sectionTitle(section: SessionSection): string {
  return LABEL[section];
}
