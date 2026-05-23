import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@/lib/types";
import { MessageItem } from "./MessageItem";
import { ArrowDown, ChevronUp, Filter, MessagesSquare, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MESSAGE_RENDER_BUDGET, MESSAGE_WINDOW_SIZE } from "@/lib/constants";

// `messages === undefined` => initial REST fetch hasn't completed yet — show
// a 5-row skeleton (review M21 UX). `[]` is the loaded-but-empty case.
type Props = {
  messages: Message[] | undefined;
  hasMoreBefore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
};

// Stable empty-array sentinel reused across MessageStream re-renders so
// `useMemo` deps that include `messages` stay stable while data is loading.
const EMPTY: Message[] = [];

function MessageStreamImpl({
  messages: messagesIn,
  hasMoreBefore = false,
  loadingOlder = false,
  onLoadOlder,
}: Props): JSX.Element {
  const isLoading = messagesIn === undefined;
  const rawMessages = messagesIn ?? EMPTY;
  // `containerRef` is bound to the Radix ScrollArea Viewport (the actual
  // overflow node). Programmatic scrolling and the at-bottom heuristic both
  // need to operate on the viewport, not the Root wrapper.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // Track the *id* of the message that was most recently the bottom of the
  // list. Used both for scroll-pin and to gate the entry animation in
  // `MessageItem` so only genuinely-new messages animate in. (Review H15.)
  const lastIdRef = useRef<string | null>(null);
  const [renderAll, setRenderAll] = useState(false);
  const [query, setQuery] = useState("");
  const [deliveryFilter, setDeliveryFilter] = useState<"all" | "direct" | "broadcast">("all");

  const messages = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rawMessages.filter((m) => {
      if (deliveryFilter !== "all" && m.deliveryMode !== deliveryFilter) return false;
      if (!q) return true;
      return (
        m.body.toLowerCase().includes(q) ||
        (m.summary?.toLowerCase().includes(q) ?? false) ||
        m.senderAlias.toLowerCase().includes(q) ||
        m.targetAliases.some((alias) => alias.toLowerCase().includes(q))
      );
    });
  }, [rawMessages, query, deliveryFilter]);

  // Last N keeps DOM lean even as the message log grows.
  const visible = useMemo(() => {
    if (messages.length <= MESSAGE_WINDOW_SIZE) return messages;
    return messages.slice(messages.length - MESSAGE_WINDOW_SIZE);
  }, [messages]);

  // Simple windowing: of the in-window messages, only render the trailing
  // `MESSAGE_RENDER_BUDGET`. Provide a "Show older" affordance for the rest.
  // We don't pull a virtualization library; the render budget keeps DOM
  // bounded at ~80 rows (review H5). Trade-off: scrolling far back into the
  // window forces a full render via the toggle rather than infinite scroll.
  const rendered = useMemo(() => {
    if (renderAll || visible.length <= MESSAGE_RENDER_BUDGET) return visible;
    return visible.slice(visible.length - MESSAGE_RENDER_BUDGET);
  }, [visible, renderAll]);
  const hiddenOlderCount = visible.length - rendered.length;

  // Group consecutive messages from the same sender; the second+ in a run
  // hides its header for a chat-like look. We also cache the parsed
  // timestamp per message to avoid re-parsing in the within-window check
  // (review H6) — Date.parse is cheap individually but repeats add up.
  const items = useMemo(() => {
    let prevParsed: number | null = null;
    return rendered.map((m, i) => {
      const parsedAt = Date.parse(m.createdAt);
      const prev = rendered[i - 1];
      const sameSender = !!prev && prev.senderAlias === m.senderAlias && prev.deliveryMode === m.deliveryMode;
      const within =
        prevParsed !== null && !Number.isNaN(parsedAt) && parsedAt - prevParsed < 60_000;
      prevParsed = Number.isNaN(parsedAt) ? prevParsed : parsedAt;
      return { msg: m, showHeader: !(sameSender && within) };
    });
  }, [rendered]);

  // Track scroll to decide if we should auto-pin.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom < 32;
      setPinned(atBottom);
      if (atBottom) setHasNew(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages when pinned; otherwise show a "new" pill.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    const isNew = !!last && lastIdRef.current !== null && last.id !== lastIdRef.current;
    lastIdRef.current = last?.id ?? null;
    if (pinned) {
      el.scrollTop = el.scrollHeight;
    } else if (isNew) {
      setHasNew(true);
    }
  }, [messages, pinned]);

  // Per-render snapshot of the prior `lastIdRef` value so MessageItem can
  // distinguish "rendered for the first time post-mount" (skip animation)
  // from "newly arrived" (animate in). Captured in a ref read inside the
  // closure below.
  const animationCutoffRef = useRef<string | null>(null);
  useEffect(() => {
    // Update *after* paint so the just-rendered items don't animate, but
    // anything added next render does.
    animationCutoffRef.current = lastIdRef.current;
  }, [messages]);
  const shouldAnimate = useCallback(
    (id: string): boolean => {
      const cutoff = animationCutoffRef.current;
      if (cutoff === null) return false;
      // Naive but cheap: only animate the very last id when it's strictly
      // different from the cutoff. The cutoff is set after each commit to
      // the previous "last id", so a brand-new tail message is detected.
      return id !== cutoff && messages[messages.length - 1]?.id === id;
    },
    [messages],
  );

  return (
    <div className="relative flex flex-col h-full min-h-0">
      <ScrollArea
        viewportRef={containerRef}
        // aria-live so AT users hear new messages as they arrive (review H3
        // UX). Polite + additions-only avoids interrupting reading flow.
        aria-live="polite"
        aria-relevant="additions"
        className="flex-1 min-h-0"
        viewportClassName="divide-y divide-border-subtle"
      >
        <div className="sticky top-0 z-10 border-b border-border-subtle bg-card/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages"
                className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none transition focus:border-primary"
              />
            </label>
            <div className="inline-flex h-8 items-center rounded-md border bg-background p-0.5">
              {(["all", "direct", "broadcast"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDeliveryFilter(value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded px-2 text-2xs uppercase tracking-wider",
                    deliveryFilter === value
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "all" ? <Filter className="size-3" /> : null}
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
        {hasMoreBefore ? (
          <div className="px-3 py-2 text-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder || !onLoadOlder}
              className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronUp className="size-3" />
              {loadingOlder ? "Loading older..." : "Load older history"}
            </button>
          </div>
        ) : null}
        {hiddenOlderCount > 0 ? (
          <div className="px-3 py-2 text-center">
            <button
              type="button"
              onClick={() => setRenderAll(true)}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronUp className="size-3" />
              Show {hiddenOlderCount} older
            </button>
          </div>
        ) : null}
        {isLoading ? (
          <div className="flex flex-col gap-2 p-3" aria-label="Loading messages">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={`msg-skel-${i}`} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-16 gap-2">
            <MessagesSquare className="size-6 opacity-50" />
            <div className="text-xs">no messages yet</div>
          </div>
        ) : (
          items.map(({ msg, showHeader }) => (
            <MessageItem
              key={msg.id}
              message={msg}
              showHeader={showHeader}
              animate={shouldAnimate(msg.id)}
            />
          ))
        )}
      </ScrollArea>
      <button
        type="button"
        aria-live="polite"
        onClick={() => {
          const el = containerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
          setHasNew(false);
          setPinned(true);
        }}
        className={cn(
          "absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full border bg-primary/90 px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-md transition",
          "hover:bg-primary",
          hasNew ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <ArrowDown className="size-3" />
        new
      </button>
    </div>
  );
}

// Memoized so unrelated parent re-renders (Tabs switch, sibling state) don't
// re-render the message list. Identity of `messages` is the dominant
// invalidation — appendMessages produces a fresh array only when new messages
// arrive.
export const MessageStream = memo(MessageStreamImpl);
