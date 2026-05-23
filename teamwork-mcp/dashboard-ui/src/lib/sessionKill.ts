import type { KillSessionResult } from "./types.js";

export type SessionKillActionVariant = "row" | "detail";

export function getSessionKillButtonLabel(
  variant: SessionKillActionVariant,
  pending: boolean,
): string {
  if (pending) return "Stopping session...";
  return variant === "detail" ? "Kill session" : "Kill";
}

export function getSessionKillSuccessMessage(result: KillSessionResult): string {
  const parts = [
    result.stoppedCount > 0
      ? `Session abandoned and stopped ${countLabel(result.stoppedCount, "worker")}.`
      : "Session abandoned.",
  ];
  if (result.alreadyStoppedCount > 0) {
    parts.push(
      `${countLabel(result.alreadyStoppedCount, "runtime")} ${result.alreadyStoppedCount === 1 ? "was" : "were"} already stopped.`,
    );
  }
  return parts.join(" ");
}

export function getSessionKillErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Failed to stop session.";
  const jsonMatch = error.message.match(/\{.*\}$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // Fall through to the plain message cleanup below.
    }
  }
  return error.message.replace(/^\d+\s+[^:]+:\s*/, "") || "Failed to stop session.";
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
