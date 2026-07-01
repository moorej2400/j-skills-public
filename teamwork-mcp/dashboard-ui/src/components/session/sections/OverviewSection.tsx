import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CopilotUsageSummary, Message, SessionDetail } from "@/lib/types";
import { getAudit, isAbortError } from "@/lib/api";
import type { SessionSection } from "@/lib/sessionSection";
import { LifecycleSummary } from "@/components/session/LifecycleSummary";
import { AgentRoster } from "@/components/session/AgentRoster";
import { AgentMapSvg } from "@/components/viz/AgentMapSvg";
import { useHoverAgent } from "@/components/session/HoverAgentContext";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { aliasBg, aliasColor } from "@/components/session/aliasColors";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";
import { STATUS_LABEL, phaseLabel } from "@/lib/workItems";

const AgentNetwork3D = lazy(() => import("@/components/viz/AgentNetwork3D"));

type Props = {
  sessionId: string;
  detail: SessionDetail;
  messages: Message[];
  onSelectAgent: (agentId: string) => void;
  onGoToSection: (section: SessionSection, agentId: string | null) => void;
};

export function OverviewSection({
  sessionId,
  detail,
  messages,
  onSelectAgent,
  onGoToSection,
}: Props): JSX.Element {
  const { hoveredAgentId } = useHoverAgent();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [forceCanvas, setForceCanvas] = useState(false);
  const [copilotUsage, setCopilotUsage] = useState<CopilotUsageSummary | null>(null);
  const showCanvas = !isMobile || forceCanvas;
  const nowMs = useNow();

  useEffect(() => {
    const ac = new AbortController();
    getAudit(sessionId, ac.signal)
      .then((report) => {
        if (!ac.signal.aborted) setCopilotUsage(report.usage?.copilot ?? null);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error("[overview] audit usage load failed", err);
      });
    return () => ac.abort();
  }, [sessionId]);

  const activeWork = useMemo(
    () =>
      detail.workItems
        .filter((w) => w.status === "in-progress" || w.status === "blocked")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
    [detail.workItems],
  );

  const recentMessages = useMemo(() => messages.slice(-5).reverse(), [messages]);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
      <div className="space-y-3 lg:col-span-8">
        <LifecycleSummary detail={detail} messages={messages} />

        <div className="relative h-[440px] overflow-hidden rounded-xl bg-card-elevated ring-1 ring-border-subtle">
          {showCanvas ? (
            <Suspense fallback={<VizFallback />}>
              <AgentNetwork3D sessionId={sessionId} hoveredAgentId={hoveredAgentId} />
            </Suspense>
          ) : (
            <div className="flex h-full w-full flex-col">
              <div className="min-h-0 flex-1">
                <AgentMapSvg sessionId={sessionId} />
              </div>
              <button
                type="button"
                onClick={() => setForceCanvas(true)}
                className="m-3 self-center rounded-full border border-border-subtle bg-card-elevated px-3 py-1.5 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                View 3D
              </button>
            </div>
          )}
        </div>

        <Card>
          <CardContent className="p-4">
            <SectionHead
              label="Active work"
              count={activeWork.length}
              onJump={() => onGoToSection("kanban", null)}
              jumpLabel="Open Kanban"
            />
            {activeWork.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                Nothing in progress right now.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {activeWork.map((wi) => {
                  const alias = wi.assigneeAliases[0] ?? wi.ownerAlias ?? "unassigned";
                  return (
                    <li
                      key={wi.workItemId}
                      className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-2"
                    >
                      <div className="text-[12px] font-medium text-foreground/95">{wi.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          className="rounded px-1.5 py-px font-medium"
                          style={{ color: aliasColor(alias), backgroundColor: aliasBg(alias, 0.12) }}
                        >
                          {alias}
                        </span>
                        <Badge variant="outline" className="px-1.5 py-0 text-2xs">
                          {STATUS_LABEL[wi.status]}
                        </Badge>
                        <span>{phaseLabel(wi.phaseNumber, detail.phases)}</span>
                        <span className="tabular-nums">{relativeTime(wi.updatedAt, nowMs)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3 lg:col-span-4">
        <AgentRoster agents={detail.agents} onSelect={onSelectAgent} />

        <CopilotUsageCard usage={copilotUsage} />

        <Card>
          <CardContent className="p-4">
            <SectionHead
              label="Latest messages"
              count={messages.length}
              onJump={() => onGoToSection("messages", null)}
              jumpLabel="Open Messages"
            />
            {recentMessages.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-subtle px-3 py-4 text-center text-xs text-muted-foreground">
                No messages yet.
              </div>
            ) : (
              <ScrollArea className="max-h-64">
                <ul className="space-y-1.5">
                  {recentMessages.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-1.5"
                    >
                      <div className="flex items-baseline gap-1.5 text-[11px]">
                        <span
                          className="font-medium"
                          style={{ color: aliasColor(m.senderAlias) }}
                        >
                          {m.senderAlias}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-muted-foreground">
                          {m.deliveryMode === "broadcast" ? "all" : m.targetAliases[0] ?? "—"}
                        </span>
                        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
                          {relativeTime(m.createdAt, nowMs)}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-foreground/90">
                        {m.summary ?? m.body}
                      </div>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CopilotUsageCard({ usage }: { usage: CopilotUsageSummary | null }): JSX.Element {
  const totals = usage?.totals;
  const hasUsage = !!totals && (
    totals.aiCredits > 0
    || totals.costUsd > 0
    || totals.inputTokens > 0
    || totals.outputTokens > 0
  );
  const runtimeCount = usage?.runtimes.length ?? 0;
  const sourceCount = usage?.sourceCount ?? 0;
  const missingCount = runtimeCount > sourceCount ? runtimeCount - sourceCount : 0;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-2xs uppercase tracking-wider text-muted-foreground">Copilot usage</div>
          <Badge variant="outline" className="px-1.5 py-0 text-2xs">
            {sourceCount}/{runtimeCount} sources
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Metric label="AI Credits" value={formatNumber(totals?.aiCredits ?? 0, 3)} />
          <Metric label="Cost" value={formatUsd(totals?.costUsd ?? 0)} />
          <Metric label="Input tokens" value={formatInteger(totals?.inputTokens ?? 0)} />
          <Metric label="Output tokens" value={formatInteger(totals?.outputTokens ?? 0)} />
        </div>

        {hasUsage ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Metric label="Cache read" value={formatInteger(totals.cacheReadInputTokens)} quiet />
            <Metric label="Cache write" value={formatInteger(totals.cacheCreationInputTokens)} quiet />
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-dashed border-border-subtle px-3 py-3 text-xs text-muted-foreground">
            No Copilot usage captured for this session yet.
          </div>
        )}

        {missingCount > 0 ? (
          <div className="mt-2 text-2xs text-muted-foreground">
            {missingCount} runtime{missingCount === 1 ? "" : "s"} without an OTel file yet.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  quiet = false,
}: {
  label: string;
  value: string;
  quiet?: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border-subtle bg-background/60 px-2.5 py-2">
      <div className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={quiet ? "text-xs font-medium tabular-nums" : "text-sm font-semibold tabular-nums"}>
        {value}
      </div>
    </div>
  );
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  });
}

function SectionHead({
  label,
  count,
  onJump,
  jumpLabel,
}: {
  label: string;
  count: number;
  onJump: () => void;
  jumpLabel: string;
}): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div className="text-2xs uppercase tracking-wider text-muted-foreground">
        {label}
        <span className="ml-1 tabular-nums">({count})</span>
      </div>
      <button
        type="button"
        onClick={onJump}
        className="inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {jumpLabel}
        <ArrowRight className="size-3" />
      </button>
    </div>
  );
}

function VizFallback(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="animate-pulse text-2xs uppercase tracking-wider text-muted-foreground">
        loading viz…
      </div>
    </div>
  );
}
