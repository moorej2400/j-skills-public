// Lightweight relative time formatter. Avoids pulling date-fns chunks for
// labels that need to update on a tick — components can call this directly
// each render and rely on a 1s setInterval in their parent.

export function relativeTime(iso: string | undefined | null, nowMs?: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const now = nowMs ?? Date.now();
  const deltaSec = Math.max(0, Math.round((now - t) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// Re-exported from `lib/utils` so existing imports (`./relativeTime`) keep
// working while new call sites pull directly from the shared utils module.
export { truncateMiddle } from "@/lib/utils";
