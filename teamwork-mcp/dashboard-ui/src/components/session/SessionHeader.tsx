import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionKillAction } from "@/components/session/SessionKillAction";
import type { KillSessionResult, SessionDetail } from "@/lib/types";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { Users, MessageSquare, GitCommit, Clock3 } from "lucide-react";

type Props = {
  detail: SessionDetail;
  onKilled?: (result: KillSessionResult) => void;
};

export function SessionHeader({ detail, onKilled }: Props): JSX.Element {
  const nowMs = useNow();
  const { session, counts } = detail;
  const status = session.status ?? "active";
  const isHistorical = status !== "active";
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            {session.title ? (
              <div className="text-sm font-semibold leading-tight text-foreground">
                {session.title}
              </div>
            ) : null}
            <div className="font-mono text-base leading-tight break-all text-foreground">
              {session.slug}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="uppercase tracking-wider text-2xs py-0">
                {session.parentCli}
              </Badge>
              <Badge
                variant={isHistorical ? "secondary" : "outline"}
                className="uppercase tracking-wider text-2xs py-0"
              >
                {status}
              </Badge>
              {session.lifecycleStage ? (
                <Badge variant="secondary" className="uppercase tracking-wider text-2xs py-0">
                  {session.lifecycleStage}
                </Badge>
              ) : null}
              <span>•</span>
              <span className="tabular-nums">created {relativeTime(session.createdAt, nowMs)}</span>
            </div>
          </div>
          <SessionKillAction session={session} variant="detail" onKilled={onKilled} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Tile icon={<Users className="size-3.5" />} label="agents" value={counts.agents} />
          <Tile icon={<MessageSquare className="size-3.5" />} label="msgs" value={counts.messages} />
          <Tile icon={<GitCommit className="size-3.5" />} label="results" value={counts.results} />
        </div>
        {session.currentPhase || session.terminalReason || session.openObligationCount ? (
          <div className="rounded-md border bg-card-elevated px-3 py-2 text-xs">
            {session.currentPhase ? (
              <div className="flex items-start gap-2">
                <Clock3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="font-medium">
                    Phase {session.currentPhase.phaseNumber}: {session.currentPhase.title}
                  </div>
                  <div className="mt-0.5 text-muted-foreground line-clamp-2">
                    {session.currentPhase.goal}
                  </div>
                </div>
              </div>
            ) : null}
            {session.terminalReason ? (
              <div className="text-muted-foreground">
                <span className="font-medium text-foreground">Closed:</span> {session.terminalReason}
              </div>
            ) : null}
            {session.openObligationCount ? (
              <div className="mt-1 text-status-warning">
                {session.openObligationCount} open obligation{session.openObligationCount === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5 flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      {/* Counts in sans + tabular-nums — they aren't code identifiers. */}
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
