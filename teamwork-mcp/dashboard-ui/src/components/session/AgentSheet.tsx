import { Suspense, lazy, useEffect, useState } from "react";
import { KanbanSquare, Terminal as TerminalIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Agent, SessionAuditReport } from "@/lib/types";
import { getAudit, isAbortError } from "@/lib/api";
import { aliasColor } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";

// xterm + addons live in a separate `terminal` chunk via vite manualChunks.
// React.lazy ensures we only fetch that chunk once the user opens the sheet
// and switches to (or starts on) the Terminal tab.
const AgentTerminal = lazy(() => import("./AgentTerminal"));

type Props = {
  sessionId: string;
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Optional jumps to the new session sub-sidebar sections. The sheet stays
  // section-agnostic; the parent decides what "open in Terminal/Kanban" does.
  onJumpToTerminal?: (agentId: string) => void;
  onJumpToWorkItems?: (agentId: string) => void;
};

const statusPillStyles: Record<Agent["status"]["state"], string> = {
  busy: "bg-status-busy/15 text-status-busy border-status-busy/30",
  idle: "bg-status-idle/10 text-status-idle border-status-idle/25",
  stopped: "bg-status-stopped/15 text-status-stopped border-status-stopped/30",
};

export function AgentSheet({
  sessionId,
  agent,
  open,
  onOpenChange,
  onJumpToTerminal,
  onJumpToWorkItems,
}: Props): JSX.Element {
  const [tab, setTab] = useState<"status" | "history" | "terminal">("status");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl lg:max-w-2xl"
      >
        {open && agent ? (
          <AgentSheetBody
            sessionId={sessionId}
            agent={agent}
            tab={tab}
            onTabChange={setTab}
            onJumpToTerminal={onJumpToTerminal ? () => onJumpToTerminal(agent.agentId) : undefined}
            onJumpToWorkItems={onJumpToWorkItems ? () => onJumpToWorkItems(agent.agentId) : undefined}
          />
        ) : (
          <div className="p-6 text-sm text-muted-foreground">No agent selected.</div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AgentSheetBody({
  sessionId,
  agent,
  tab,
  onTabChange,
  onJumpToTerminal,
  onJumpToWorkItems,
}: {
  sessionId: string;
  agent: Agent;
  tab: "status" | "history" | "terminal";
  onTabChange: (next: "status" | "history" | "terminal") => void;
  onJumpToTerminal?: () => void;
  onJumpToWorkItems?: () => void;
}): JSX.Element {
  const accent = aliasColor(agent.alias);
  return (
    <>
      <SheetHeader className="border-b px-5 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <span
            className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
            aria-hidden
          />
          <SheetTitle className="truncate" style={{ color: accent }}>
            {agent.alias}
          </SheetTitle>
          <Badge variant="outline" className="text-2xs uppercase tracking-wider py-0">
            {agent.specialty || "worker"}
          </Badge>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-medium uppercase tracking-wide",
              statusPillStyles[agent.status.state],
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                agent.status.state === "busy" && "bg-status-busy animate-pulse",
                agent.status.state === "idle" && "bg-status-idle",
                agent.status.state === "stopped" && "bg-status-stopped",
              )}
            />
            {agent.status.state}
          </span>
        </div>
        <SheetDescription className="font-mono">
          {agent.cli} · {agent.model}
        </SheetDescription>
        {onJumpToTerminal || onJumpToWorkItems ? (
          <div className="flex items-center gap-1.5 pt-2">
            {onJumpToTerminal ? (
              <button
                type="button"
                onClick={onJumpToTerminal}
                className="inline-flex items-center gap-1 rounded border border-border-subtle bg-card-elevated px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <TerminalIcon className="size-3" />
                Open Terminal
              </button>
            ) : null}
            {onJumpToWorkItems ? (
              <button
                type="button"
                onClick={onJumpToWorkItems}
                className="inline-flex items-center gap-1 rounded border border-border-subtle bg-card-elevated px-2 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <KanbanSquare className="size-3" />
                Filter Kanban
              </button>
            ) : null}
          </div>
        ) : null}
      </SheetHeader>
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as "status" | "history" | "terminal")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-5 pt-3">
          <TabsList>
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="status" className="m-0 mt-0 flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <StatusPanel agent={agent} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="history" className="m-0 mt-0 flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <HistoryPanel sessionId={sessionId} agent={agent} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="terminal" className="m-0 mt-0 flex-1 min-h-0 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center p-6">
                <Skeleton className="h-full w-full" />
              </div>
            }
          >
            <AgentTerminal
              sessionId={sessionId}
              agentId={agent.agentId}
              runtimeId={agent.runtime?.runtimeId}
              inputDelivery={agent.runtime?.inputDelivery}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-1.5">
      <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xs text-foreground break-all">{children}</div>
    </div>
  );
}

function StatusPanel({ agent }: { agent: Agent }): JSX.Element {
  const nowMs = useNow();
  const r = agent.runtime;
  return (
    <div className="px-5 py-4">
      <div className="rounded-md border bg-card-elevated p-3">
        <div className="text-xs font-semibold text-foreground">
          {agent.status.state}
          {agent.status.summary ? <span className="font-normal text-muted-foreground"> — {agent.status.summary}</span> : null}
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">
          updated {relativeTime(agent.status.updatedAt, nowMs)}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-2xs uppercase tracking-wider text-muted-foreground mb-2">Runtime</div>
        <div className="rounded-md border divide-y divide-border-subtle">
          <div className="px-3 py-2">
            <Field label="CLI">{agent.cli}</Field>
            <Field label="Model"><span className="font-mono">{agent.model}</span></Field>
            {agent.reasoningEffort ? <Field label="Reasoning">{agent.reasoningEffort}</Field> : null}
            <Field label="Specialty">{agent.specialty || "—"}</Field>
            {r?.worktreePath ? <Field label="Worktree"><span className="font-mono">{r.worktreePath}</span></Field> : null}
            {r?.sessionHandle ? <Field label="Session"><span className="font-mono">{r.sessionHandle}</span></Field> : null}
            {r?.runtimeCommand ? <Field label="Command"><span className="font-mono">{r.runtimeCommand}</span></Field> : null}
            {r?.lifecycleState ? <Field label="Lifecycle">{r.lifecycleState}</Field> : null}
            {r?.startedAt ? <Field label="Started">{relativeTime(r.startedAt, nowMs)}</Field> : null}
            {r?.exitedAt ? <Field label="Exited">{relativeTime(r.exitedAt, nowMs)} (code {r.exitCode ?? "?"})</Field> : null}
            {agent.heartbeat ? (
              <Field label="Heartbeat">
                {relativeTime(agent.heartbeat.updatedAt, nowMs)}
                {agent.heartbeat.summary ? (
                  <span className="ml-1 text-muted-foreground italic">— {agent.heartbeat.summary}</span>
                ) : null}
              </Field>
            ) : null}
            <Field label="Created">{relativeTime(agent.createdAt, nowMs)}</Field>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({ sessionId, agent }: { sessionId: string; agent: Agent }): JSX.Element {
  const nowMs = useNow();
  const [report, setReport] = useState<SessionAuditReport | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setReport(null);
    setError(null);
    getAudit(sessionId, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setReport(r);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => ac.abort();
  }, [sessionId, agent.agentId]);

  if (error) {
    return <div className="p-5 text-xs text-status-stopped">Failed to load history: {error.message}</div>;
  }
  if (!report) {
    return (
      <div className="space-y-2 p-5">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  }
  const rec = report.agents.find((a) => a.agentId === agent.agentId);
  if (!rec) {
    return <div className="p-5 text-xs text-muted-foreground">No audit data for this agent yet.</div>;
  }

  // The audit endpoint summarizes counts rather than streaming individual
  // status events; surface that summary as a compact stat grid plus the
  // last-known status so the panel is meaningful today and easy to extend
  // when the backend grows a per-event timeline.
  const cells: Array<[string, string | number]> = [
    ["Status changes", rec.statusChangeCount],
    ["Busy", rec.busyStatusCount],
    ["Idle", rec.idleStatusCount],
    ["Stopped", rec.stoppedStatusCount],
    ["Blocked", rec.blockedStatusCount],
    ["Sent", rec.sentCount],
    ["Received", rec.receivedCount],
    ["Acknowledged", rec.acknowledgedCount],
    ["Assignments", rec.assignmentCount],
    ["Done", rec.doneAssignmentCount],
    ["Blocked assigns", rec.blockedAssignmentCount],
    ["Results", rec.resultCount],
  ];

  return (
    <div className="px-5 py-4">
      <div className="text-2xs uppercase tracking-wider text-muted-foreground mb-2">Activity rollup</div>
      <div className="grid grid-cols-3 gap-2">
        {cells.map(([label, value]) => (
          <div key={label} className="rounded-md border bg-card-elevated px-3 py-2">
            <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-md border bg-card-elevated p-3 text-xs">
        <div className="text-2xs uppercase tracking-wider text-muted-foreground mb-1">Latest</div>
        <div>
          <span className="font-semibold">{rec.statusState}</span>
          {rec.statusSummary ? <span className="text-muted-foreground"> — {rec.statusSummary}</span> : null}
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">
          last status {relativeTime(rec.lastStatusAt, nowMs)}
          {rec.lastHeartbeatAt ? <> · last heartbeat {relativeTime(rec.lastHeartbeatAt, nowMs)}</> : null}
        </div>
        {rec.totalRuntimeSeconds > 0 ? (
          <div className="mt-1 text-2xs text-muted-foreground">
            total runtime {Math.round(rec.totalRuntimeSeconds)}s across {rec.runtimeCount} run(s)
          </div>
        ) : null}
      </div>
    </div>
  );
}
