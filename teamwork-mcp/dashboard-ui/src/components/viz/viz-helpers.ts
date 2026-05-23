import * as THREE from "three";
import type { AgentStatusState } from "@/lib/types";

// Cache `cssVarToColor` results in a module-level Map so repeated callers
// (every AgentNode tick, every Particle render) avoid the getComputedStyle
// reflow + regex parse + new THREE.Color allocation. Cleared via
// `clearVizColorCache()` on theme-change events (no-op today, future-friendly).
const COLOR_CACHE = new Map<string, THREE.Color>();

export function clearVizColorCache(): void {
  COLOR_CACHE.clear();
}

// Reads an `--name` CSS custom property whose value is HSL channels in the
// "H S% L%" form used across `index.css` and converts to a THREE.Color.
// Falls back to opaque white if the variable isn't present (e.g., during SSR).
export function cssVarToColor(name: string): THREE.Color {
  const cached = COLOR_CACHE.get(name);
  if (cached) return cached;

  if (typeof window === "undefined" || typeof document === "undefined") {
    const fallback = new THREE.Color(0xffffff);
    COLOR_CACHE.set(name, fallback);
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) {
    const fallback = new THREE.Color(0xffffff);
    COLOR_CACHE.set(name, fallback);
    return fallback;
  }

  // Accept "H S% L%" or "hsl(H S% L%)".
  const match = raw.match(
    /(?:hsl\(\s*)?(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/,
  );
  if (!match) {
    const fallback = new THREE.Color(0xffffff);
    COLOR_CACHE.set(name, fallback);
    return fallback;
  }
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const c = new THREE.Color();
  c.setHSL(h, s, l);
  COLOR_CACHE.set(name, c);
  return c;
}

// Place an item on a flat ring on the XZ plane (slight Y jitter avoided
// because OrbitControls + a circle on Y=0 reads cleanly with autoRotate).
export function placeOnRing(
  index: number,
  count: number,
  radius: number,
): [number, number, number] {
  if (count <= 0) return [0, 0, 0];
  const angle = (index / count) * Math.PI * 2;
  return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

// Map an agent status to a themed THREE.Color. Anything unknown shares the
// muted color so we never leak a hardcoded hue into the scene. Returns the
// cached cssVarToColor instance directly — callers must not mutate.
// Resolve a status to its semantic token (`--status-*`) so the 3D scene
// shares the same palette as agent cards, dots, the lifecycle bar, and
// assignments. Unknown statuses fall back to the muted idle tone.
export function colorForStatus(status: AgentStatusState | string | undefined): THREE.Color {
  switch (status) {
    case "busy":
      return cssVarToColor("--status-busy");
    case "stopped":
      return cssVarToColor("--status-stopped");
    case "idle":
      return cssVarToColor("--status-idle");
    default:
      return cssVarToColor("--status-idle");
  }
}

// Heuristic: in teamwork the parent agent id is `parent@<slug>` and
// alias is "parent". Fall back to alias check so future renames still work.
export function isParentAgent(agentId: string, alias?: string): boolean {
  if (alias?.toLowerCase() === "parent") return true;
  return agentId.startsWith("parent@");
}
