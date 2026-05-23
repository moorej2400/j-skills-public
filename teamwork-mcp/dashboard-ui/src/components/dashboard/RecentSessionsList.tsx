import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SessionKillAction } from "@/components/session/SessionKillAction";
import type { KillSessionResult, SessionSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";

export function RecentSessionsList({
  sessions,
  onKilled,
}: {
  sessions: SessionSummary[];
  onKilled?: (result: KillSessionResult) => void;
}): JSX.Element | null {
  // Auto-expand when only a handful of recent sessions (review M15 UX);
  // larger lists default to collapsed so the dashboard doesn't push the
  // charts off-screen.
  const [open, setOpen] = useState(sessions.length <= 5);
  const nowMs = useNow();
  // Stable per-instance id so the trigger can `aria-controls` the region. AT
  // users get the proper expand/collapse relationship. (Review M10.)
  const regionId = useId();
  if (sessions.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={open}
          aria-controls={regionId}
        >
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold tracking-tight">
              Recent sessions
            </CardTitle>
            <Badge variant="secondary" className="text-xs">
              {sessions.length}
            </Badge>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="pt-0" id={regionId}>
          <Separator className="mb-3" />
            <ul className="divide-y divide-border-subtle">
              {sessions.map((session) => (
                <li key={session.id} className="flex items-center gap-3 py-2.5">
                  <Link
                    to={`/sessions/${session.id}`}
                    className={cn(
                      "group flex min-w-0 flex-1 items-center justify-between gap-4",
                      "transition-colors hover:text-primary hover:underline underline-offset-4",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <code className="truncate font-mono text-sm">
                        {session.slug}
                      </code>
                      <Badge variant="secondary" className="text-xs uppercase tracking-[0.08em]">
                        {session.parentCli}
                      </Badge>
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                      {relativeTime(session.createdAt, nowMs)}
                    </span>
                  </Link>
                  <SessionKillAction session={session} variant="row" onKilled={onKilled} />
                </li>
              ))}
            </ul>
          <div className="mt-3 border-t border-border-subtle pt-3">
            <Link
              to="/history"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              Open full history
            </Link>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
