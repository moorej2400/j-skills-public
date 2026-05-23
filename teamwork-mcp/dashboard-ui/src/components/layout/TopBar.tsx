import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { Command, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/store/sessionStore";
import { useSseHealth } from "@/lib/sse";
import { cn } from "@/lib/utils";

// Productized TopBar (review H6 UX). Replaces the dead `pathname` mono row
// with a real human breadcrumb on the left, a "[N sessions live · M agents
// busy]" presence strip mid-bar, and a Cmd-K placeholder + SSE health pip on
// the right. The Command palette itself is deferred (out of scope per the
// task brief); we render the trigger button so the visual cue lands.
export function TopBar({ onMenuClick }: { onMenuClick?: () => void }): JSX.Element {
  const location = useLocation();
  const summaries = useSessionStore((s) => s.summaries);
  const details = useSessionStore((s) => s.details);
  const setPaletteOpen = useSessionStore((s) => s.setPaletteOpen);
  const health = useSseHealth();

  const breadcrumb = useMemo(() => crumbsFor(location.pathname), [location.pathname]);

  const { liveSessions, busyAgents } = useMemo(() => {
    let live = 0;
    let busy = 0;
    for (const detail of Object.values(details)) {
      const anyLive = detail.agents.some((a) => a.status.state !== "stopped");
      if (anyLive) live += 1;
      for (const a of detail.agents) if (a.status.state === "busy") busy += 1;
    }
    if (live === 0) live = Object.keys(summaries).length;
    return { liveSessions: live, busyAgents: busy };
  }, [details, summaries]);

  const dotClass =
    health === "connected"
      ? "bg-status-busy"
      : health === "reconnecting"
        ? "bg-status-warning"
        : "bg-status-stopped";

  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-background/60 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>
      {/* Breadcrumb (sans, no mono) */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {breadcrumb.map((c, i) => (
          <span key={`${c.label}-${i}`} className="inline-flex items-center gap-2 min-w-0">
            {i > 0 ? <span className="text-muted-foreground/50">/</span> : null}
            <span
              className={cn(
                "truncate",
                i === breadcrumb.length - 1
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {c.label}
            </span>
          </span>
        ))}
      </nav>
      {/* Live presence strip */}
      <div className="hidden items-center gap-3 text-2xs uppercase tracking-wider text-muted-foreground sm:flex">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", dotClass, health === "connected" && "animate-pulse")} />
          <span className="tabular-nums text-foreground">{liveSessions}</span>
          <span>{liveSessions === 1 ? "session" : "sessions"} live</span>
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular-nums text-foreground">{busyAgents}</span>
          <span>{busyAgents === 1 ? "agent" : "agents"} busy</span>
        </span>
      </div>
      {/* Cmd-K trigger — opens the global CommandPalette mounted in AppShell. */}
      <Button
        variant="outline"
        size="sm"
        className="hidden h-7 gap-1.5 px-2 text-2xs text-muted-foreground sm:inline-flex"
        title="Command palette (⌘K)"
        aria-label="Open command palette"
        onClick={() => setPaletteOpen(true)}
      >
        <Command className="h-3 w-3" />
        <span>K</span>
      </Button>
    </header>
  );
}

type Crumb = { label: string };
function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/" || pathname === "") return [{ label: "Dashboard" }];
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "sessions" && parts[1]) {
    return [{ label: "Sessions" }, { label: parts[1] }];
  }
  if (parts[0] === "sessions") return [{ label: "Sessions" }];
  return [{ label: parts.join(" / ") }];
}
