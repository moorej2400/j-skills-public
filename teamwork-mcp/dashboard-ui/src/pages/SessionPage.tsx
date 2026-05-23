import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useSessionStore, EMPTY_MESSAGES } from "@/store/sessionStore";
import { getMessages, getSessionDetail, isAbortError } from "@/lib/api";
import { useSessionStream, useSseHealth } from "@/lib/sse";
import { useSessionSection, type SessionSection } from "@/lib/sessionSection";
import { SessionHeader } from "@/components/session/SessionHeader";
import { SessionSubSidebar, sectionTitle } from "@/components/session/SessionSubSidebar";
import { AgentSheet } from "@/components/session/AgentSheet";
import { HoverAgentProvider } from "@/components/session/HoverAgentContext";
import { OverviewSection } from "@/components/session/sections/OverviewSection";
import { KanbanSection } from "@/components/session/sections/KanbanSection";
import { MessagesSection } from "@/components/session/sections/MessagesSection";
import { AgentsSection } from "@/components/session/sections/AgentsSection";
import { TerminalSection } from "@/components/session/sections/TerminalSection";
import { ResultsSection } from "@/components/session/sections/ResultsSection";
import { TimelineSection } from "@/components/session/sections/TimelineSection";
import { cn } from "@/lib/utils";

const DETAIL_REFRESH_DEBOUNCE_MS = 2000;
const MESSAGE_PAGE_SIZE = 200;

export default function SessionPage(): JSX.Element {
  return (
    <HoverAgentProvider>
      <SessionPageInner />
    </HoverAgentProvider>
  );
}

function SessionPageInner(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>();
  const detail = useSessionStore((s) => (sessionId ? s.details[sessionId] : undefined));
  // Pass the raw selector through so MessageStream can distinguish "not yet
  // fetched" (undefined → skeleton) from "loaded but empty" (`[]` → empty
  // state). The EMPTY_MESSAGES sentinel is still used elsewhere where the
  // distinction doesn't matter.
  const messagesArr = useSessionStore((s) =>
    sessionId ? s.messages[sessionId] : undefined,
  );
  const lifecycleMessages = messagesArr ?? EMPTY_MESSAGES;
  const mergeDetail = useSessionStore((s) => s.mergeDetail);
  const appendMessages = useSessionStore((s) => s.appendMessages);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const selectedAgentId = useSessionStore((s) => s.selectedAgentId);
  const selectAgent = useSessionStore((s) => s.selectAgent);
  const sseHealth = useSseHealth();

  const [initialError, setInitialError] = useState<Error | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const sessionStatus = detail?.session.status ?? "active";
  const isHistorical = !!detail && sessionStatus !== "active";

  // Historical sessions default to Timeline (preserves the old behavior where
  // the message stream is mostly empty and the timeline is the natural entry).
  const defaultSection: SessionSection = isHistorical ? "timeline" : "overview";
  const { section, agentParam, setSection, setAgent, setSectionAndAgent } =
    useSessionSection(defaultSection);

  const [unread, setUnread] = useState<Partial<Record<SessionSection, number>>>({});

  // Document title — prefix with "● N busy" when the session has busy agents
  // so a row of browser tabs shows where work is happening.
  const busyCount = detail?.agents.filter((a) => a.status.state === "busy").length ?? 0;
  useEffect(() => {
    if (!sessionId) {
      document.title = "Teamwork";
      return;
    }
    document.title = busyCount > 0
      ? `● ${busyCount} busy · ${sessionId} · Teamwork`
      : `${sessionId} · Teamwork`;
    return () => {
      document.title = "Teamwork";
    };
  }, [sessionId, busyCount]);

  const lastMessageSequenceRef = useRef<number | null>(null);
  useEffect(() => {
    lastMessageSequenceRef.current = null;
    setHasMoreBefore(false);
  }, [sessionId]);
  useEffect(() => {
    if (lifecycleMessages.length > 0) {
      lastMessageSequenceRef.current = lifecycleMessages[lifecycleMessages.length - 1]!.sequence;
    }
  }, [lifecycleMessages]);

  useEffect(() => {
    if (!sessionId) return;
    const ac = new AbortController();
    setInitialError(null);
    Promise.all([
      getSessionDetail(sessionId, ac.signal).then((d) => {
        if (!ac.signal.aborted) mergeDetail(d);
      }),
      getMessages(sessionId, undefined, MESSAGE_PAGE_SIZE, ac.signal).then((page) => {
        if (!ac.signal.aborted) {
          appendMessages(sessionId, page.messages);
          setHasMoreBefore(!!page.hasMoreBefore);
        }
      }),
    ]).catch((err) => {
      if (isAbortError(err)) return;
      console.error("[session] initial load failed", err);
      setInitialError(err instanceof Error ? err : new Error(String(err)));
    });
    return () => ac.abort();
  }, [sessionId, mergeDetail, appendMessages, retryToken]);

  const refreshTimer = useRef<number | null>(null);
  const queueRefresh = useCallback(() => {
    if (!sessionId) return;
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void getSessionDetail(sessionId)
        .then((d) => mergeDetail(d))
        .catch((err) => {
          if (!isAbortError(err)) console.error("[session] detail refresh failed", err);
        });
      }, DETAIL_REFRESH_DEBOUNCE_MS);
  }, [sessionId, mergeDetail]);
  const refreshDetailNow = useCallback(() => {
    if (!sessionId) return;
    void getSessionDetail(sessionId)
      .then((d) => mergeDetail(d))
      .catch((err) => {
        if (!isAbortError(err)) console.error("[session] detail refresh failed", err);
      });
  }, [sessionId, mergeDetail]);

  const loadOlderMessages = useCallback(() => {
    if (!sessionId || loadingOlder) return;
    const firstSequence = messagesArr?.[0]?.sequence;
    if (!firstSequence) return;
    setLoadingOlder(true);
    getMessages(sessionId, undefined, MESSAGE_PAGE_SIZE, undefined, firstSequence)
      .then((page) => {
        appendMessages(sessionId, page.messages);
        setHasMoreBefore(!!page.hasMoreBefore);
      })
      .catch((err) => {
        if (!isAbortError(err)) console.error("[session] older messages load failed", err);
      })
      .finally(() => setLoadingOlder(false));
  }, [sessionId, messagesArr, loadingOlder, appendMessages]);

  // Bump an unread counter on the sub-sidebar pill when SSE updates land for a
  // section that isn't currently visible. Cleared when the user switches to it.
  const bumpUnread = useCallback(
    (s: SessionSection) => {
      if (section === s) return;
      setUnread((u) => ({ ...u, [s]: (u[s] ?? 0) + 1 }));
    },
    [section],
  );

  useSessionStream(detail && (detail.session.status ?? "active") === "active" ? sessionId : null, {
    message: (e) => {
      if (!sessionId) return;
      applyEvent(e);
      void getMessages(
        sessionId,
        lastMessageSequenceRef.current !== null ? String(lastMessageSequenceRef.current) : undefined,
      )
        .then((page) => {
          if (page.messages.length > 0) appendMessages(sessionId, page.messages);
        })
        .catch((err) => {
          if (!isAbortError(err)) console.error("[session] messages tick failed", err);
        });
      if (e.kind === "sent") bumpUnread("messages");
    },
    agent: (e) => {
      applyEvent(e);
      queueRefresh();
    },
    status: (e) => {
      applyEvent(e);
      queueRefresh();
    },
    assignment: (e) => {
      applyEvent(e);
      queueRefresh();
      bumpUnread("kanban");
    },
    result: (e) => {
      applyEvent(e);
      queueRefresh();
      bumpUnread("results");
    },
    checkpoint: (e) => {
      applyEvent(e);
      queueRefresh();
      bumpUnread("results");
    },
    runtime: (e) => {
      applyEvent(e);
      queueRefresh();
    },
    heartbeat: (e) => applyEvent(e),
    shutdown: (e) => applyEvent(e),
    output: (e) => applyEvent(e),
  });

  // Clear the unread counter for whichever section is currently visible.
  useEffect(() => {
    if (unread[section]) {
      setUnread((u) => ({ ...u, [section]: 0 }));
    }
  }, [section, unread]);

  const onSubSidebarSelect = useCallback(
    (next: SessionSection) => {
      setSection(next);
    },
    [setSection],
  );

  const onSelectAgentForSection = useCallback(
    (agentId: string | null) => setAgent(agentId),
    [setAgent],
  );
  const onGoToSection = useCallback(
    (next: SessionSection, agentId: string | null) => setSectionAndAgent(next, agentId),
    [setSectionAndAgent],
  );

  if (!sessionId) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Missing session id.</CardContent></Card>;
  }

  if (initialError && !detail) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <div className="text-sm font-medium text-foreground">Failed to load session</div>
          <div className="text-xs text-muted-foreground break-all">{initialError.message}</div>
          <button
            type="button"
            onClick={() => setRetryToken((t) => t + 1)}
            className="rounded-md border bg-primary/90 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary"
          >
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-2">
          <Skeleton className="h-64" />
        </div>
        <div className="space-y-3 lg:col-span-10">
          <Skeleton className="h-32" />
          <Skeleton className="h-[560px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* sr-only h1 — semantic page title. The slug shows visually inside
          SessionHeader but isn't an h1 there. */}
      <h1 className="sr-only">{detail.session.slug}</h1>

      <BreadcrumbStrip
        slug={detail.session.slug}
        parentCli={detail.session.parentCli}
        busyCount={busyCount}
        sseHealth={sseHealth}
        status={sessionStatus}
        sectionLabel={sectionTitle(section)}
        onRetrySse={() => setRetryToken((t) => t + 1)}
      />

      <SessionHeader detail={detail} onKilled={() => refreshDetailNow()} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <aside aria-label="Session sections" className="lg:col-span-2 lg:sticky lg:top-4 lg:self-start">
          <SessionSubSidebar
            detail={detail}
            messages={messagesArr}
            active={section}
            onSelect={onSubSidebarSelect}
            unread={unread}
          />
        </aside>

        <section className="min-w-0 lg:col-span-10">
          {section === "overview" && (
            <OverviewSection
              sessionId={sessionId}
              detail={detail}
              messages={lifecycleMessages}
              onSelectAgent={(id) => selectAgent(id)}
              onGoToSection={onGoToSection}
            />
          )}
          {section === "kanban" && (
            <KanbanSection
              detail={detail}
              agentParam={agentParam}
              onSelectAgent={onSelectAgentForSection}
            />
          )}
          {section === "messages" && (
            <MessagesSection
              messages={messagesArr}
              hasMoreBefore={hasMoreBefore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlderMessages}
            />
          )}
          {section === "agents" && (
            <AgentsSection
              sessionId={sessionId}
              detail={detail}
              agentParam={agentParam}
              onSelectAgent={onSelectAgentForSection}
              onGoToSection={onGoToSection}
            />
          )}
          {section === "terminal" && (
            <TerminalSection
              sessionId={sessionId}
              detail={detail}
              agentParam={agentParam}
              onSelectAgent={onSelectAgentForSection}
            />
          )}
          {section === "results" && <ResultsSection detail={detail} />}
          {section === "timeline" && (
            <TimelineSection detail={detail} messages={lifecycleMessages} />
          )}
        </section>
      </div>

      <AgentSheet
        sessionId={sessionId}
        agent={detail.agents.find((a) => a.agentId === selectedAgentId) ?? null}
        open={!!selectedAgentId}
        onOpenChange={(open) => {
          if (!open) selectAgent(null);
        }}
        onJumpToTerminal={(agentId) => {
          selectAgent(null);
          onGoToSection("terminal", agentId);
        }}
        onJumpToWorkItems={(agentId) => {
          selectAgent(null);
          onGoToSection("kanban", agentId);
        }}
      />
    </div>
  );
}

function BreadcrumbStrip({
  slug,
  parentCli,
  busyCount,
  sseHealth,
  status,
  sectionLabel,
  onRetrySse,
}: {
  slug: string;
  parentCli: string;
  busyCount: number;
  sseHealth: "connected" | "reconnecting" | "disconnected";
  status: string;
  sectionLabel: string;
  onRetrySse: () => void;
}): JSX.Element {
  const isHistorical = status !== "active";
  const dotClass =
    sseHealth === "connected"
      ? "bg-status-busy animate-pulse"
      : sseHealth === "reconnecting"
        ? "bg-status-warning"
        : "bg-status-stopped";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Link to="/" className="hover:text-foreground transition-colors">
        Sessions
      </Link>
      <span className="text-muted-foreground/50">/</span>
      <span className="text-foreground font-mono">{slug}</span>
      <span className="text-muted-foreground/50">/</span>
      <span className="text-foreground">{sectionLabel}</span>
      <Badge variant="outline" className="ml-1 text-2xs uppercase tracking-wider py-0">
        {parentCli}
      </Badge>
      {isHistorical ? (
        <Badge variant="secondary" className="text-2xs uppercase tracking-wider py-0">
          {status} replay
        </Badge>
      ) : null}
      {busyCount > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-status-busy/15 px-2 py-px text-2xs text-status-busy">
          <span className="h-1.5 w-1.5 rounded-full bg-status-busy animate-pulse" />
          {busyCount} busy
        </span>
      ) : null}
      {isHistorical ? (
        <span className="ml-auto text-2xs uppercase tracking-wider text-muted-foreground">
          read-only
        </span>
      ) : (
        <span
          className="ml-auto inline-flex items-center gap-1.5"
          title={`Live connection: ${sseHealth}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
          <span className="text-2xs uppercase tracking-wider">{sseHealth}</span>
          {sseHealth === "disconnected" ? (
            <button
              type="button"
              onClick={onRetrySse}
              className="ml-1 rounded border border-border-subtle px-1.5 py-px text-2xs hover:text-foreground"
            >
              retry
            </button>
          ) : null}
        </span>
      )}
    </div>
  );
}
