import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, parseISO } from "date-fns";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Truncate a long path-like string in the middle so both the prefix and suffix
// remain visible. Used for worktree paths, slugs, etc.
export function truncateMiddle(s: string | undefined, max = 32): string {
  if (!s) return "";
  if (s.length <= max) return s;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

// Format an ISO date as "MMM d", falling back to the raw string if parsing
// fails. Shared between MessagesChart and SessionsChart.
export function safeFormatChartDate(date: string): string {
  try {
    return format(parseISO(date), "MMM d");
  } catch {
    return date;
  }
}
