import type React from "react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Agent, KillSessionResult, SessionSummary } from "@/lib/types";
import { SessionCard } from "./SessionCard";
import { useRovingFocus } from "@/lib/useRovingFocus";

export type SessionsGridProps = {
  sessions: SessionSummary[];
  agentsBySession: Record<string, Agent[]>;
  /**
   * Map of sessionId → ISO timestamps of recently observed messages.
   * Driven by SSE events; defaults to empty array when no data yet.
   */
  recentMessagesBySession: Record<string, string[]>;
  /** Map of sessionId → most-recent activity timestamp (ISO). */
  lastActivityBySession: Record<string, string | undefined>;
  loading?: boolean;
  onKilled?: (result: KillSessionResult) => void;
};

// Live sessions intentionally render as a board of operational cards instead
// of another divider list so the dashboard stops reading like the same table
// twice with different data.
export function SessionsGrid({
  sessions,
  agentsBySession,
  recentMessagesBySession,
  lastActivityBySession,
  loading,
  onKilled,
}: SessionsGridProps): JSX.Element {
  const navigate = useNavigate();
  const onActivate = useCallback(
    (i: number) => {
      const s = sessions[i];
      if (s) navigate(`/sessions/${s.id}`);
    },
    [sessions, navigate],
  );
  const { getItemProps, containerRef } = useRovingFocus({
    count: sessions.length,
    onActivate,
  });

  if (loading && sessions.length === 0) {
    return (
      <ul className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <li
            key={`skeleton-${i}`}
            className="rounded-[1.6rem] border border-border-subtle bg-card/80 p-4"
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <Skeleton className="h-7 w-28 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-5 w-52" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-64" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Skeleton className="h-24 rounded-2xl" />
                <Skeleton className="h-24 rounded-2xl" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-[1.8rem] border border-dashed border-border-subtle bg-card/40 p-12 text-center">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <Inbox className="h-5 w-5" />
        </div>
        <div>
          <p className="text-base font-medium">No active sessions</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Spin up a session via the MCP tools to see it appear here in real time.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <ul className="grid gap-4 xl:grid-cols-2">
        {sessions.map((session, idx) => {
          const item = getItemProps(idx);
          return (
            <SessionCard
              key={session.id}
              index={idx}
              session={session}
              agents={agentsBySession[session.id] ?? []}
              recentMessageTimestamps={recentMessagesBySession[session.id] ?? []}
              lastActivityAt={lastActivityBySession[session.id]}
              tabIndex={item.tabIndex}
              linkRef={item.ref as (el: HTMLAnchorElement | null) => void}
              onFocus={item.onFocus as (e: React.FocusEvent<HTMLAnchorElement>) => void}
              onKilled={onKilled}
            />
          );
        })}
      </ul>
    </div>
  );
}
