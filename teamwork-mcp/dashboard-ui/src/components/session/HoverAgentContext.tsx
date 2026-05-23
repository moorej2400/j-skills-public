import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// Per-page context for the hovered agent id. Previously lived in the global
// zustand store (`hoveredAgentId`) which leaked across navigations and would
// be incorrect with multiple tabs/sessions in view. Bound to `SessionPage`.

type Ctx = {
  hoveredAgentId: string | null;
  setHoveredAgent: (id: string | null) => void;
};

const HoverAgentContext = createContext<Ctx | null>(null);

export function HoverAgentProvider({ children }: { children: ReactNode }): JSX.Element {
  const [hoveredAgentId, setHoveredAgent] = useState<string | null>(null);
  const value = useMemo(() => ({ hoveredAgentId, setHoveredAgent }), [hoveredAgentId]);
  return <HoverAgentContext.Provider value={value}>{children}</HoverAgentContext.Provider>;
}

export function useHoverAgent(): Ctx {
  const ctx = useContext(HoverAgentContext);
  if (!ctx) {
    // Fallback no-op so consumers rendered outside the provider (e.g. in
    // isolated tests) don't crash.
    return { hoveredAgentId: null, setHoveredAgent: () => {} };
  }
  return ctx;
}
