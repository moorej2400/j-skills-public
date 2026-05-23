import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { Agent, KillSessionResult, SessionSummary } from "@/lib/types";
import { SessionKillAction } from "@/components/session/SessionKillAction";
import { AgentDots } from "./AgentDots";
import { MessageSparkline } from "./MessageSparkline";

export type SessionCardProps = {
  session: SessionSummary;
  agents: Agent[];
  recentMessageTimestamps: string[];
  lastActivityAt?: string;
  index?: number;
  // Roving-tabindex hooks from SessionsGrid for j/k navigation.
  tabIndex?: number;
  linkRef?: (el: HTMLAnchorElement | null) => void;
  onFocus?: (e: React.FocusEvent<HTMLAnchorElement>) => void;
  onKilled?: (result: KillSessionResult) => void;
};

// Renders one session as a divider-separated list row. Replaced the previous
// 3-col card-grid + primary-glow hover (taste-skill flagged both the
// "3-Column Cards" anti-pattern and the neon outer glow). Hover affordance is
// now a background tint on the row + chevron color shift, no shadow.
export function SessionCard({
  session,
  agents,
  recentMessageTimestamps,
  lastActivityAt,
  index = 0,
  tabIndex,
  linkRef,
  onFocus,
  onKilled,
}: SessionCardProps): JSX.Element {
  const nowMs = useNow();
  const reduced = useReducedMotion();
  const busy = agents.filter((a) => a.status.state === "busy").length;
  const total = agents.length;
  const statusText = busy > 0 ? "Currently busy" : total > 0 ? "Monitoring" : "Waiting for agents";
  const statusClass =
    busy > 0
      ? "border-primary/30 bg-primary/10 text-primary"
      : total > 0
        ? "border-accent-2/25 bg-accent-2/10 text-accent-2"
        : "border-border-strong bg-muted/60 text-muted-foreground";
  const phaseLabel = session.currentPhase
    ? `Phase ${session.currentPhase.phaseNumber}: ${session.currentPhase.title}`
    : session.lifecycleStage
      ? session.lifecycleStage
      : "Live session";
  const activityLabel = lastActivityAt ? relativeTime(lastActivityAt, nowMs) : "Waiting for first event";
  const messageCount = recentMessageTimestamps.length;

  return (
    <motion.li
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: index * 0.02, ease: "easeOut" }}
      className="list-none"
    >
      <article
        className={cn(
          "group relative overflow-hidden rounded-[1.6rem] border border-border-subtle bg-card/90 shadow-[0_18px_50px_-34px_rgba(0,0,0,0.9)] transition-colors duration-200",
          "hover:border-primary/25 hover:bg-card-elevated/95",
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_hsl(var(--primary)/0.12),_transparent_48%),radial-gradient(circle_at_bottom_right,_hsl(var(--accent-2)/0.08),_transparent_36%)]"
        />
        <div className="relative p-4 sm:p-5">
          <Link
            to={`/sessions/${session.id}`}
            className={cn(
              "block min-w-0 rounded-[1.2rem] focus:outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
            tabIndex={tabIndex}
            ref={linkRef}
            onFocus={onFocus}
          >
            <div className="space-y-4">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2.5 pr-24">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium tracking-[0.08em]",
                      statusClass,
                    )}
                  >
                    {statusText}
                  </span>
                  <Badge variant="secondary" className="shrink-0 text-xs uppercase tracking-[0.08em]">
                    {session.parentCli}
                  </Badge>
                  <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                    Opened {relativeTime(session.createdAt, nowMs)}
                  </span>
                </div>

                <div className="space-y-2">
                  <code className="block truncate font-mono text-base font-semibold text-foreground sm:text-lg">
                    {session.slug}
                  </code>
                  <p className="text-sm text-foreground/88">{phaseLabel}</p>
                  {session.currentPhase?.goal ? (
                    <p className="max-w-[60ch] text-sm text-muted-foreground">
                      {session.currentPhase.goal}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2 tabular-nums">
                    <span className="font-medium text-foreground">{messageCount}</span>
                    {messageCount === 1 ? "message this hour" : "messages this hour"}
                  </span>
                  <span className="hidden text-muted-foreground/40 sm:inline">•</span>
                  <span className="inline-flex items-center gap-2">
                    <ArrowUpRight className="h-4 w-4 text-primary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    Open session
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <HoverCard openDelay={120} closeDelay={80}>
                  <HoverCardTrigger asChild>
                    <div className="min-w-0 rounded-[1.1rem] border border-border-subtle bg-background/45 p-3.5">
                      <span className="block text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                        Agents active
                      </span>
                      <div className="mt-2 flex min-w-0 flex-col items-start gap-2">
                        <span className="text-lg font-semibold tabular-nums text-foreground">
                          {busy}/{total}
                        </span>
                        <AgentDots agents={agents} max={12} className="w-full justify-start" />
                      </div>
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent align="start" className="w-72">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Agents
                    </div>
                    {agents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No agents registered.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {agents.map((a) => (
                          <li key={a.agentId} className="flex items-center justify-between gap-3 text-sm">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  a.status.state === "busy" && "bg-status-busy",
                                  a.status.state === "idle" && "bg-status-idle",
                                  a.status.state === "stopped" && "bg-status-stopped",
                                )}
                              />
                              <span className="truncate font-medium">{a.alias}</span>
                            </div>
                            <span className="font-mono text-xs text-muted-foreground">
                              {a.cli}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </HoverCardContent>
                </HoverCard>

                <div className="min-w-0 rounded-[1.1rem] border border-border-subtle bg-background/45 p-3.5">
                  <span className="block text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Last activity
                  </span>
                  <div className="mt-2 text-sm font-medium text-foreground">{activityLabel}</div>
                  <div className="mt-3">
                    <MessageSparkline timestamps={recentMessageTimestamps} className="w-full" />
                  </div>
                </div>
              </div>
            </div>
          </Link>

          <SessionKillAction
            session={session}
            variant="row"
            onKilled={onKilled}
            className="absolute right-4 top-4 h-9 rounded-xl px-3 text-sm sm:right-5 sm:top-5"
          />
        </div>
      </article>
    </motion.li>
  );
}
