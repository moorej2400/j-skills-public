import { useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionLabel } from "@/components/ui/section-label";
import type { Agent } from "@/lib/types";
import { AgentCard } from "./AgentCard";
import { Users } from "lucide-react";
import { useRovingFocus } from "@/lib/useRovingFocus";
import { useSessionStore } from "@/store/sessionStore";

type Props = { agents: Agent[]; onSelect?: (agentId: string) => void };

const stateOrder: Record<Agent["status"]["state"], number> = { busy: 0, idle: 1, stopped: 2 };

export function AgentRoster({ agents, onSelect }: Props): JSX.Element {
  // Memoize on `agents` so the 1-second nowMs tick from the parent doesn't
  // re-sort on every render (review H2). Sort is tiny but called per second
  // for every roster item — adds up.
  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const so = stateOrder[a.status.state] - stateOrder[b.status.state];
        if (so !== 0) return so;
        return a.alias.localeCompare(b.alias);
      }),
    [agents],
  );

  // j/k roving focus over the roster. Enter on a focused card delegates to
  // the same `onSelect` worker B's AgentSheet wires up. If `onSelect` isn't
  // provided we fall back to the global `selectAgent` store action so the
  // CommandPalette + j/k both end up firing the same signal.
  const fallbackSelect = useSessionStore((s) => s.selectAgent);
  const activate = useCallback(
    (idx: number) => {
      const agent = sorted[idx];
      if (!agent) return;
      if (onSelect) onSelect(agent.agentId);
      else fallbackSelect(agent.agentId);
    },
    [sorted, onSelect, fallbackSelect],
  );

  const { getItemProps, containerRef } = useRovingFocus({
    count: sorted.length,
    onActivate: activate,
  });

  return (
    <Card className="flex flex-col">
      <CardContent className="p-4 pb-2 flex flex-col gap-3 min-h-0">
        <div className="flex items-center justify-between">
          <SectionLabel>
            <Users className="size-3" />
            roster
          </SectionLabel>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {agents.length}
          </span>
        </div>
        {/* dvh for mobile address-bar safety; aligns with the sticky parent
            wrapper added in SessionPage's right rail (review H11 UX). */}
        <ScrollArea className="max-h-[calc(100dvh-7rem)] pr-2 -mr-2">
          <div className="flex flex-col gap-2" ref={containerRef}>
            {sorted.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center">no agents</div>
            ) : (
              sorted.map((a, i) => {
                const item = getItemProps(i);
                return (
                  <AgentCard
                    key={a.agentId}
                    agent={a}
                    index={i}
                    onSelect={onSelect ?? fallbackSelect}
                    tabIndex={item.tabIndex}
                    cardRef={item.ref as (el: HTMLDivElement | null) => void}
                    onFocus={item.onFocus}
                  />
                );
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
