import { useEffect, useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { LayoutDashboard, Network, User } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSessionStore } from "@/store/sessionStore";
import { relativeTime } from "@/components/session/relativeTime";
import { useNow } from "@/lib/useNow";

// Cmd-K command palette. Mounted once at the App level (inside a Router so
// `useNavigate`/`useParams` work). Open state lives in the zustand store so
// the TopBar trigger and the global keydown listener share one source of
// truth.
//
// Categories:
//   - Sessions: every known session summary, navigates on select.
//   - Agents: only when on a session page; selecting fires `selectAgent` on
//     the store, which SessionPage subscribes to in order to open the
//     AgentSheet (worker B's contract).
//   - Actions: "Go to dashboard".
export function CommandPalette(): JSX.Element {
  const open = useSessionStore((s) => s.paletteOpen);
  const setOpen = useSessionStore((s) => s.setPaletteOpen);
  const summariesMap = useSessionStore((s) => s.summaries);
  const detailsMap = useSessionStore((s) => s.details);
  const selectAgent = useSessionStore((s) => s.selectAgent);

  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ sessionId?: string }>();
  // `useParams` only resolves params on the matched route. The palette is
  // mounted at the app level (no route match), so we can't rely on it —
  // derive the active session id from the pathname instead.
  const activeSessionId = useMemo(() => {
    const m = location.pathname.match(/^\/sessions\/([^/]+)/);
    return m?.[1] ?? params.sessionId ?? null;
  }, [location.pathname, params.sessionId]);

  const nowMs = useNow();

  // Global keydown: Cmd-K (mac) / Ctrl-K (everyone else) toggles. Skip when
  // the user is typing in an input/textarea/contenteditable so the shortcut
  // doesn't steal keystrokes from the message composer (or wherever).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "k" && ev.key !== "K") return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      // Cmd/Ctrl-K is the conventional command-palette shortcut; intercept it
      // even from inside form inputs (matches VS Code / Linear / etc.).
      ev.preventDefault();
      setOpen(!open);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const sessions = useMemo(
    () =>
      Object.values(summariesMap).sort((a, b) =>
        (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt),
      ),
    [summariesMap],
  );

  const activeAgents = useMemo(() => {
    if (!activeSessionId) return [];
    return detailsMap[activeSessionId]?.agents ?? [];
  }, [activeSessionId, detailsMap]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search sessions, agents, actions…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {sessions.length > 0 ? (
          <CommandGroup heading="Sessions">
            {sessions.map((s) => {
              const last = s.lastActivityAt ?? s.createdAt;
              return (
                <CommandItem
                  key={s.id}
                  value={`session ${s.slug} ${s.id} ${s.parentCli}`}
                  onSelect={() => {
                    setOpen(false);
                    navigate(`/sessions/${s.id}`);
                  }}
                >
                  <Network className="opacity-60" />
                  <span className="font-mono text-sm">{s.slug}</span>
                  <span className="ml-2 text-2xs uppercase tracking-wider text-muted-foreground">
                    {s.parentCli}
                  </span>
                  <span className="ml-auto flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
                    <span>
                      {s.agentCount} {s.agentCount === 1 ? "agent" : "agents"}
                    </span>
                    <span>·</span>
                    <span>{relativeTime(last, nowMs)}</span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {activeAgents.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents (this session)">
              {activeAgents.map((a) => (
                <CommandItem
                  key={a.agentId}
                  value={`agent ${a.alias} ${a.agentId} ${a.specialty} ${a.cli}`}
                  onSelect={() => {
                    setOpen(false);
                    selectAgent(a.agentId);
                  }}
                >
                  <User className="opacity-60" />
                  <span className="text-sm">{a.alias}</span>
                  <span className="ml-2 truncate text-2xs text-muted-foreground">
                    {a.specialty}
                  </span>
                  <span className="ml-auto text-2xs uppercase tracking-wider text-muted-foreground">
                    {a.status.state}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="action go to dashboard sessions home"
            onSelect={() => {
              setOpen(false);
              navigate("/");
            }}
          >
            <LayoutDashboard className="opacity-60" />
            <span>Go to dashboard</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
