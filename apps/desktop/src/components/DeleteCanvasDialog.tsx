/** Confirms deleting a canvas, which destroys its only copy on this device. */
import * as React from "react";
import { RiAlertLine, RiDeleteBinLine } from "@remixicon/react";

import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export interface DeleteCanvasDialogProps {
  open: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteCanvasDialog({
  open,
  name,
  busy,
  error,
  onConfirm,
  onCancel,
}: DeleteCanvasDialogProps) {
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => confirmRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const Icon = RiDeleteBinLine;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-canvas-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <Icon className="size-5 text-destructive" />
          <h2 id="delete-canvas-title" className="text-base">
            Delete this canvas?
          </h2>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">{name}</span> is
              stored only on this device. Its drawing and its chat history are
              deleted with it, and there is no way to get them back.
        </p>

        {error ? (
          <div className="flex items-start gap-2 p-2.5 border border-destructive/30 bg-destructive/10 text-destructive text-xs">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span className="leading-snug">{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="gap-1.5"
          >
            {busy ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
            {busy ? "Deleting..." : "Delete canvas"}
          </Button>
        </div>
      </div>
    </div>
  );
}
