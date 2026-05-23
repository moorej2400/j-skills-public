import { CheckCircle2, ClipboardList, GitCommit, MessageSquare, Radio } from "lucide-react";
import type { Agent, Assignment, Checkpoint, Message, Result } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { aliasBg, aliasColor } from "./aliasColors";

type Props = {
  messages: Message[];
  assignments: Assignment[];
  results: Result[];
  checkpoints: Checkpoint[];
  agents: Agent[];
};

type TimelineItem =
  | { id: string; at: string; kind: "message"; message: Message }
  | { id: string; at: string; kind: "assignment"; assignment: Assignment }
  | { id: string; at: string; kind: "result"; result: Result; agentAlias: string }
  | { id: string; at: string; kind: "checkpoint"; checkpoint: Checkpoint };

export function SessionTimeline({
  messages,
  assignments,
  results,
  checkpoints,
  agents,
}: Props): JSX.Element {
  const aliasById = new Map(agents.map((a) => [a.agentId, a.alias]));
  const items: TimelineItem[] = [
    ...messages.map((message) => ({ id: message.id, at: message.createdAt, kind: "message" as const, message })),
    ...assignments.map((assignment) => ({ id: assignment.id, at: assignment.updatedAt, kind: "assignment" as const, assignment })),
    ...results.map((result) => ({
      id: result.id,
      at: result.createdAt,
      kind: "result" as const,
      result,
      agentAlias: aliasById.get(result.agentId) ?? result.agentId.slice(0, 8),
    })),
    ...checkpoints.map((checkpoint) => ({ id: checkpoint.id, at: checkpoint.createdAt, kind: "checkpoint" as const, checkpoint })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
        No timeline events yet.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ol className="relative mx-4 my-3 border-l border-border-subtle pl-4">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="relative pb-4">
            <span className="absolute -left-[23px] top-1 flex size-4 items-center justify-center rounded-full border bg-card">
              <TimelineIcon item={item} />
            </span>
            <TimelineRow item={item} />
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function TimelineIcon({ item }: { item: TimelineItem }): JSX.Element {
  if (item.kind === "message") {
    return item.message.deliveryMode === "broadcast"
      ? <Radio className="size-2.5 text-muted-foreground" />
      : <MessageSquare className="size-2.5 text-muted-foreground" />;
  }
  if (item.kind === "assignment") return <ClipboardList className="size-2.5 text-muted-foreground" />;
  if (item.kind === "result") return <GitCommit className="size-2.5 text-muted-foreground" />;
  return <CheckCircle2 className="size-2.5 text-muted-foreground" />;
}

function TimelineRow({ item }: { item: TimelineItem }): JSX.Element {
  const at = new Date(item.at).toLocaleString();
  if (item.kind === "message") {
    const m = item.message;
    return (
      <div className="rounded-md border bg-card-elevated px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[11px] font-medium"
            style={{ color: aliasColor(m.senderAlias), backgroundColor: aliasBg(m.senderAlias, 0.12) }}
          >
            {m.senderAlias}
          </span>
          <Badge variant="secondary" className="text-2xs uppercase tracking-wider">
            {m.deliveryMode}
          </Badge>
          {m.kind ? (
            <Badge variant="outline" className="text-2xs uppercase tracking-wider">
              {m.kind}
            </Badge>
          ) : null}
          <span className="ml-auto font-mono text-2xs text-muted-foreground">{at}</span>
        </div>
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/85">
          {m.summary || m.body}
        </div>
      </div>
    );
  }
  if (item.kind === "assignment") {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.assignment.summary}</span>
          <Badge variant="outline" className="text-2xs uppercase tracking-wider">
            {item.assignment.status}
          </Badge>
          <span className="ml-auto font-mono text-2xs text-muted-foreground">{at}</span>
        </div>
        <div className="mt-1 text-muted-foreground">{item.assignment.phase}</div>
      </div>
    );
  }
  if (item.kind === "result") {
    return (
      <div className="rounded-md border bg-status-busy/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.result.summary}</span>
          <Badge variant="secondary" className="text-2xs">{item.agentAlias}</Badge>
          <span className="ml-auto font-mono text-2xs text-muted-foreground">{at}</span>
        </div>
        {item.result.commitSha ? (
          <div className="mt-1 font-mono text-2xs text-muted-foreground">{item.result.commitSha}</div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-status-warning/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">{item.checkpoint.summary}</span>
        <span className="ml-auto font-mono text-2xs text-muted-foreground">{at}</span>
      </div>
      {item.checkpoint.mergeCommitSha ? (
        <div className="mt-1 font-mono text-2xs text-muted-foreground">
          {item.checkpoint.mergeCommitSha}
        </div>
      ) : null}
    </div>
  );
}
