import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Message } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { aliasColor, aliasBg } from "./aliasColors";
import { relativeTime } from "./relativeTime";
import { useNow } from "@/lib/useNow";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { MessageSquare, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  message: Message;
  showHeader: boolean;
  // Controlled by `MessageStream`: only set true when this is a brand-new
  // tail message; existing items in the rendered window get a static
  // initial state to avoid re-running the entry animation on scroll.
  animate?: boolean;
};

const BODY_COLLAPSE_LINES = 6;

export function MessageItem({ message, showHeader, animate = false }: Props): JSX.Element {
  const nowMs = useNow();
  const reduced = useReducedMotion();
  const senderColor = aliasColor(message.senderAlias);
  const senderBg = aliasBg(message.senderAlias, 0.12);
  const isBroadcast = message.deliveryMode === "broadcast";
  // Highlight orchestrator (parent) messages with a thin gold-tinted left
  // accent rule (review brand #4 UX). Uses the existing --status-warning
  // amber so we don't have to add a dedicated --accent-gold token.
  const isParent = message.senderAlias?.toLowerCase() === "parent";

  // Replace the nested-scroll <pre> with a "show first N lines, then expand
  // inline" pattern. Nested vertical scroll inside the chat list breaks the
  // outer scroll handoff and is awkward on touch. (Review M5/N14.)
  const [expanded, setExpanded] = useState(false);
  const { preview, hasMore } = useMemo(() => {
    if (!message.body) return { preview: "", hasMore: false };
    const lines = message.body.split("\n");
    if (lines.length <= BODY_COLLAPSE_LINES) {
      return { preview: message.body, hasMore: false };
    }
    return { preview: lines.slice(0, BODY_COLLAPSE_LINES).join("\n"), hasMore: true };
  }, [message.body]);

  return (
    <motion.div
      // Subtler entrance: small `y` rise + opacity, faster (review H15 UX).
      // Gated by `animate` so only genuinely-new tail messages animate.
      // Skipped entirely under prefers-reduced-motion.
      initial={animate && !reduced ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14 }}
      className={cn(
        "px-3 py-1",
        isParent && "border-l-2 border-l-status-warning/70 pl-2.5",
      )}
    >
      {showHeader && (
        <div className="flex items-center gap-2 pb-1">
          <div
            className="rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none"
            style={{ color: senderColor, backgroundColor: senderBg }}
          >
            {message.senderAlias}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {isBroadcast ? <Radio className="size-3" /> : <MessageSquare className="size-3" />}
            {isBroadcast ? (
              <Badge variant="secondary" className="px-1 py-0 text-[9px] uppercase tracking-wide">
                broadcast
              </Badge>
            ) : (
              <span className="inline-flex flex-wrap gap-1">
                {message.targetAliases.length > 0 ? (
                  message.targetAliases.map((alias) => (
                    <span
                      key={alias}
                      className="rounded px-1 py-px font-mono text-[9.5px]"
                      style={{ color: aliasColor(alias), backgroundColor: aliasBg(alias, 0.1) }}
                    >
                      → {alias}
                    </span>
                  ))
                ) : (
                  <span className="font-mono text-[9.5px]">→ {message.toAgentId}</span>
                )}
              </span>
            )}
          </div>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
            {relativeTime(message.createdAt, nowMs)}
          </span>
        </div>
      )}

      <div className="pl-1">
        {showHeader ? (
          <div className="mb-1 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
            <span>seq {message.sequence}</span>
            {message.kind ? <span>{message.kind}</span> : null}
            {message.requiresResponse ? (
              <span className="rounded bg-status-warning/15 px-1 py-px text-status-warning">
                response required
              </span>
            ) : null}
            <span>{new Date(message.createdAt).toLocaleString()}</span>
          </div>
        ) : null}
        {message.summary && (
          <div className="text-[12px] font-semibold leading-snug text-foreground/95">
            {message.summary}
          </div>
        )}
        {message.body && (
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85">
            {expanded ? message.body : preview}
            {hasMore && !expanded ? (
              <>
                {"\n"}
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-primary hover:underline"
                >
                  Show more…
                </button>
              </>
            ) : null}
            {hasMore && expanded ? (
              <>
                {"\n"}
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="text-primary hover:underline"
                >
                  Show less
                </button>
              </>
            ) : null}
          </pre>
        )}
      </div>
    </motion.div>
  );
}
