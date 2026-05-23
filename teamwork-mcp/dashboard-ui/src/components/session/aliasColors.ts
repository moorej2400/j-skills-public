// Stable per-alias HSL color derived from a string hash. Used to color-code
// agents consistently across the message stream and roster.

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Module-level memoization: alias→hue is pure, and these helpers are called
// dozens of times per render (every MessageItem, AgentCard, ResultsRow…). The
// cache key is the alias string; identity-stable returns also keep style
// objects shallow-equal across renders. Cleared only by reload.
const HUE_CACHE = new Map<string, number>();
const COLOR_CACHE = new Map<string, string>();
const BG_CACHE = new Map<string, string>();

export function aliasHue(alias: string): number {
  const key = alias || "?";
  const cached = HUE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const hue = hashString(key) % 360;
  HUE_CACHE.set(key, hue);
  return hue;
}

export function aliasColor(alias: string, opts: { sat?: number; light?: number } = {}): string {
  // Fast path: only cache the default-arg variant. Custom sat/light bypasses
  // the cache so callers tweaking opacity/light never see stale values.
  if (opts.sat === undefined && opts.light === undefined) {
    const cached = COLOR_CACHE.get(alias);
    if (cached) return cached;
    const hue = aliasHue(alias);
    const out = `hsl(${hue} 70% 60%)`;
    COLOR_CACHE.set(alias, out);
    return out;
  }
  const hue = aliasHue(alias);
  const sat = opts.sat ?? 70;
  const light = opts.light ?? 60;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export function aliasBg(alias: string, alpha = 0.15): string {
  // Compound key on alpha because callers vary it (0.10, 0.12, 0.15…).
  const key = `${alias}|${alpha}`;
  const cached = BG_CACHE.get(key);
  if (cached) return cached;
  const hue = aliasHue(alias);
  const out = `hsl(${hue} 70% 60% / ${alpha})`;
  BG_CACHE.set(key, out);
  return out;
}
