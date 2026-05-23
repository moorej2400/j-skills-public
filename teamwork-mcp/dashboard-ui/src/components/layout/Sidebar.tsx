import { NavLink } from "react-router-dom";
import { Boxes, History, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_API_PORT } from "@/lib/constants";
import { useSseHealth } from "@/lib/sse";
import packageJson from "../../../package.json";

const items = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/sessions", label: "Sessions", icon: Boxes, end: false },
  { to: "/history", label: "History", icon: History, end: false },
];

const API_PORT = (import.meta.env.VITE_API_PORT as string | undefined) ?? String(DEFAULT_API_PORT);
const APP_VERSION = (packageJson as { version?: string }).version ?? "0.0.0";

export function Sidebar(): JSX.Element {
  const health = useSseHealth();
  const dotClass =
    health === "connected"
      ? "bg-status-busy animate-pulse"
      : health === "reconnecting"
        ? "bg-status-warning"
        : "bg-status-stopped";
  return (
    <aside
      aria-label="Primary navigation"
      className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex"
    >
      <div className="flex h-14 items-center gap-2 px-5 border-b border-border">
        <div className="h-7 w-7 rounded-md bg-primary/20 ring-1 ring-primary/40 flex items-center justify-center">
          <span className="text-primary font-mono text-xs font-semibold">at</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-none">Teamwork</span>
          <span className="text-2xs text-muted-foreground leading-none mt-1">v{APP_VERSION}</span>
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )
            }
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      {/* Footer: SSE health dot + port (mono — it IS code-ish) + version. */}
      <div className="border-t border-border p-3 text-2xs text-muted-foreground flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn("h-1.5 w-1.5 rounded-full", dotClass)}
            aria-label={`Live connection: ${health}`}
          />
          <span className="font-mono">port {API_PORT}</span>
        </span>
        <span className="font-mono">v{APP_VERSION}</span>
      </div>
    </aside>
  );
}
