import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Terminal as TerminalIcon } from "lucide-react";
import type { Agent, SessionDetail } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { aliasColor } from "@/components/session/aliasColors";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";

const AgentTerminal = lazy(() => import("@/components/session/AgentTerminal"));

type Props = {
  sessionId: string;
  detail: SessionDetail;
  agentParam: string | null;
  onSelectAgent: (agentId: string | null) => void;
};

type RuntimeBucket = "running" | "stopped" | "none";

function bucketFor(agent: Agent): RuntimeBucket {
  const lifecycle = agent.runtime?.lifecycleState;
  if (lifecycle === "running") return "running";
  if (lifecycle === "stopped" || lifecycle === "crashed") return "stopped";
  return "none";
}

export function TerminalSection({ sessionId, detail, agentParam, onSelectAgent }: Props): JSX.Element {
  const workers = useMemo(() => detail.agents.filter((a) => a.role !== "parent"), [detail.agents]);
  const grouped = useMemo(() => {
    const out: Record<RuntimeBucket, Agent[]> = { running: [], stopped: [], none: [] };
    for (const a of workers) out[bucketFor(a)].push(a);
    for (const k of Object.keys(out) as RuntimeBucket[]) {
      out[k].sort((a, b) => a.alias.localeCompare(b.alias));
    }
    return out;
  }, [workers]);

  // Default to the first running agent when no `?agent=` is present.
  useEffect(() => {
    if (agentParam) return;
    const first = grouped.running[0] ?? grouped.stopped[0] ?? workers[0];
    if (first) onSelectAgent(first.agentId);
  }, [agentParam, grouped, workers, onSelectAgent]);

  const selected = agentParam ? detail.agents.find((a) => a.agentId === agentParam) ?? null : null;
  const [showStopped, setShowStopped] = useState(true);

  return (
    <div className="grid h-[calc(100dvh-13rem)] min-h-[480px] grid-cols-1 gap-3 md:grid-cols-[18rem_1fr]">
      <aside className="overflow-hidden rounded-lg border border-border-subtle bg-card/40">
        <header className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Runtimes
          </div>
          <span className="text-2xs tabular-nums text-muted-foreground">
            {grouped.running.length} running
          </span>
        </header>
        <ScrollArea className="h-[calc(100%-2.25rem)]">
          <div className="flex flex-col p-2 gap-1">
            {workers.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">No workers</div>
            ) : (
              <>
                <RuntimeGroup
                  label="Running"
                  agents={grouped.running}
                  selected={selected?.agentId ?? null}
                  onSelect={onSelectAgent}
                  defaultOpen
                />
                <RuntimeGroup
                  label={`Stopped (${grouped.stopped.length})`}
                  agents={grouped.stopped}
                  selected={selected?.agentId ?? null}
                  onSelect={onSelectAgent}
                  defaultOpen={showStopped}
                  onToggle={() => setShowStopped((v) => !v)}
                />
                {grouped.none.length > 0 ? (
                  <RuntimeGroup
                    label={`No runtime (${grouped.none.length})`}
                    agents={grouped.none}
                    selected={selected?.agentId ?? null}
                    onSelect={onSelectAgent}
                    defaultOpen={false}
                  />
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[400px] flex-col overflow-hidden rounded-lg border border-border-subtle bg-card/40">
        {selected ? (
          <SelectedTerminal sessionId={sessionId} agent={selected} />
        ) : (
          <NoSelectionState />
        )}
      </section>
    </div>
  );
}

function RuntimeGroup({
  label,
  agents,
  selected,
  onSelect,
  defaultOpen,
  onToggle,
}: {
  label: string;
  agents: Agent[];
  selected: string | null;
  onSelect: (id: string) => void;
  defaultOpen: boolean;
  onToggle?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);
  // Sync controlled toggle (used for the Stopped group whose state lives in
  // the parent so it persists across re-renders driven by SSE).
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  if (agents.length === 0 && !label.startsWith("Stopped")) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (onToggle) onToggle();
          else setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1">
          {agents.length === 0 ? (
            <div className="px-2 py-2 text-2xs italic text-muted-foreground/60">empty</div>
          ) : (
            agents.map((a) => (
              <RuntimeRow
                key={a.agentId}
                agent={a}
                selected={selected === a.agentId}
                onSelect={() => onSelect(a.agentId)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function RuntimeRow({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const nowMs = useNow();
  const lifecycle = agent.runtime?.lifecycleState;
  const lifeDot =
    lifecycle === "running"
      ? "bg-status-busy animate-pulse"
      : lifecycle === "crashed"
        ? "bg-status-stopped"
        : lifecycle === "stopped"
          ? "bg-status-stopped/70"
          : "bg-muted-foreground/40";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
        selected
          ? "border-l-2 border-l-primary border-border bg-primary/10"
          : "border-border-subtle bg-background/40 hover:bg-muted/40",
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", lifeDot)} aria-hidden />
      <span
        className="truncate text-[12px] font-medium"
        style={{ color: aliasColor(agent.alias) }}
      >
        {agent.alias}
      </span>
      <span className="ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground tabular-nums">
        {agent.runtime?.lastOutputAt ? relativeTime(agent.runtime.lastOutputAt, nowMs) : "—"}
      </span>
    </button>
  );
}

function SelectedTerminal({ sessionId, agent }: { sessionId: string; agent: Agent }): JSX.Element {
  const nowMs = useNow();
  const r = agent.runtime;
  const lifecycle = r?.lifecycleState ?? "no runtime";
  const accent = aliasColor(agent.alias);
  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
        <span className="inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
        <span className="text-sm font-semibold" style={{ color: accent }}>
          {agent.alias}
        </span>
        <Badge variant="outline" className="py-0 text-2xs uppercase tracking-wider">
          {agent.specialty || "worker"}
        </Badge>
        <Badge variant="outline" className="py-0 text-2xs uppercase tracking-wider">
          {lifecycle}
        </Badge>
        {r?.startedAt ? (
          <span className="text-2xs text-muted-foreground">
            started {relativeTime(r.startedAt, nowMs)}
          </span>
        ) : null}
        {r?.worktreePath ? (
          <span className="ml-auto truncate font-mono text-2xs text-muted-foreground" title={r.worktreePath}>
            {r.worktreePath}
          </span>
        ) : null}
      </header>
      <div className="flex-1 min-h-0">
        {r ? (
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
              runtimeId={r.runtimeId}
              inputDelivery={r.inputDelivery}
            />
          </Suspense>
        ) : (
          <NoRuntimeState />
        )}
      </div>
    </>
  );
}

function NoSelectionState(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <TerminalIcon className="size-6 opacity-50" />
      <div className="text-sm">Pick a running agent on the left.</div>
    </div>
  );
}

function NoRuntimeState(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <div className="text-sm">This agent has no recorded runtime.</div>
      <div className="text-xs">Pick another agent from the list to see live output.</div>
    </div>
  );
}
