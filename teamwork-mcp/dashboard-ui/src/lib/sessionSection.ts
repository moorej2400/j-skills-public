import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

// Session-local sub-sidebar sections. The URL `?section=` query param is the
// source of truth so deep-links and refresh restore the view. The `?agent=`
// param scopes Terminal/Agents/Kanban-filter to a single agent across section
// switches.

export type SessionSection =
  | "overview"
  | "kanban"
  | "messages"
  | "agents"
  | "terminal"
  | "results"
  | "timeline";

export const SESSION_SECTIONS: readonly SessionSection[] = [
  "overview",
  "kanban",
  "messages",
  "agents",
  "terminal",
  "results",
  "timeline",
];

const SECTION_SET = new Set<string>(SESSION_SECTIONS);

export function isSessionSection(value: string | null | undefined): value is SessionSection {
  return !!value && SECTION_SET.has(value);
}

export function parseSection(
  value: string | null | undefined,
  fallback: SessionSection,
): SessionSection {
  return isSessionSection(value) ? value : fallback;
}

export type UseSessionSection = {
  section: SessionSection;
  agentParam: string | null;
  setSection: (next: SessionSection) => void;
  setAgent: (next: string | null) => void;
  setSectionAndAgent: (next: SessionSection, nextAgent: string | null) => void;
};

// `defaultSection` lets the caller pick a different fallback for historical
// sessions (the legacy page defaults historical to Timeline).
export function useSessionSection(defaultSection: SessionSection = "overview"): UseSessionSection {
  const [params, setParams] = useSearchParams();
  const raw = params.get("section");
  const section = parseSection(raw, defaultSection);
  const agentParam = params.get("agent");

  const update = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params);
      mutate(next);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const setSection = useCallback(
    (next: SessionSection) => {
      update((p) => {
        if (next === defaultSection) p.delete("section");
        else p.set("section", next);
      });
    },
    [update, defaultSection],
  );

  const setAgent = useCallback(
    (next: string | null) => {
      update((p) => {
        if (!next) p.delete("agent");
        else p.set("agent", next);
      });
    },
    [update],
  );

  const setSectionAndAgent = useCallback(
    (next: SessionSection, nextAgent: string | null) => {
      update((p) => {
        if (next === defaultSection) p.delete("section");
        else p.set("section", next);
        if (!nextAgent) p.delete("agent");
        else p.set("agent", nextAgent);
      });
    },
    [update, defaultSection],
  );

  return useMemo(
    () => ({ section, agentParam, setSection, setAgent, setSectionAndAgent }),
    [section, agentParam, setSection, setAgent, setSectionAndAgent],
  );
}
