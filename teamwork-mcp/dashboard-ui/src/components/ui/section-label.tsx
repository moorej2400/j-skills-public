import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Eyebrow-style label used above sections, card content, and roster headers.
// Replaces the ~14 copy-pasted
// `text-xs uppercase tracking-wider text-muted-foreground` instances around
// the codebase (review N7). Compose with optional inline icons via children.
export function SectionLabel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "h2" | "h3" | "span";
}): JSX.Element {
  return (
    <Tag
      className={cn(
        "inline-flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
