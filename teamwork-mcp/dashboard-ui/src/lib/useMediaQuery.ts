import { useEffect, useState } from "react";

// Tiny `window.matchMedia` wrapper. Used by SessionPage to swap the 3D viz
// for a static SVG fallback below the `md` breakpoint (review M30 UX). SSR
// safe — defaults to `false` on the server / before the first effect runs.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
