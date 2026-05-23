import { useReducedMotion as useFramerReducedMotion } from "framer-motion";

// Thin re-export of framer-motion's `useReducedMotion` so the rest of the
// codebase doesn't import framer-motion directly just to read the
// `prefers-reduced-motion` user preference. SSR-safe (framer guards
// `window.matchMedia`); returns `null` until the preference is read.
//
// Treat `null` as "no preference yet" — most call sites should fall through
// the motion-enabled branch, which is what `Boolean(useReducedMotion())`
// effectively does.
export function useReducedMotion(): boolean {
  return Boolean(useFramerReducedMotion());
}
