import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { killSession } from "@/lib/api";
import {
  getSessionKillButtonLabel,
  getSessionKillErrorMessage,
  getSessionKillSuccessMessage,
  type SessionKillActionVariant,
} from "@/lib/sessionKill";
import type { KillSessionResult, Session, SessionSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type KillableSession = Pick<Session, "id" | "slug" | "status"> | Pick<SessionSummary, "id" | "slug" | "status">;

type Props = {
  session: KillableSession;
  variant: SessionKillActionVariant;
  onKilled?: (result: KillSessionResult) => void;
  className?: string;
};

export function SessionKillAction({
  session,
  variant,
  onKilled,
  className,
}: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if ((session.status ?? "active") === "archived") return null;

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await killSession(session.id);
      toast.success(getSessionKillSuccessMessage(result), {
        id: `kill-session-${session.id}`,
      });
      setOpen(false);
      onKilled?.(result);
    } catch (err) {
      setError(getSessionKillErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn(
          "shrink-0 border-destructive/25 text-destructive hover:bg-destructive/10 hover:text-destructive",
          variant === "detail" ? "min-w-[8.5rem]" : "px-2.5",
          className,
        )}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={pending}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {getSessionKillButtonLabel(variant, pending)}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill session {session.slug}?</DialogTitle>
            <DialogDescription>
              This stops tracked worker CLIs, marks the session abandoned, and still
              records already-stopped runtimes cleanly.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirm()}
              disabled={pending}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {pending ? "Stopping session..." : "Kill session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
