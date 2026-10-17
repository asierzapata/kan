import * as React from "react";
import { RiAddLine, RiAlertLine } from "@remixicon/react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { createCanvas, type CreatedCanvas } from "@/lib/create-canvas";

export interface CreateCanvasDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (canvas: CreatedCanvas) => void;
}

export function CreateCanvasDialog({
  open,
  onClose,
  onCreated,
}: CreateCanvasDialogProps) {
  const [name, setName] = React.useState("Untitled Canvas");
  const [isCreating, setIsCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;

    setName("Untitled Canvas");
    setError(null);
    setIsCreating(false);

    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);

    return () => clearTimeout(focusTimer);
  }, [open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Canvas name cannot be empty");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      onCreated(await createCanvas(trimmed));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create the canvas",
      );
      setIsCreating(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-canvas-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isCreating) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <RiAddLine className="size-5 text-primary" />
          <h2 id="create-canvas-title" className="text-base">
            New canvas
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="create-canvas-name"
              className="text-sm font-sans font-medium text-foreground"
            >
              Name
            </label>
            <Input
              ref={inputRef}
              id="create-canvas-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              disabled={isCreating}
              autoComplete="off"
              className="text-sm"
            />
            <p className="text-xs leading-snug text-muted-foreground">
              Saved on this device. Private, works with no connection.
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 p-2.5 border border-destructive/30 bg-destructive/10 text-destructive text-xs"
            >
              <RiAlertLine className="size-4 shrink-0 mt-0.5" />
              <span className="leading-snug">{error}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={isCreating || !name.trim()}
              className="gap-1.5"
            >
              {isCreating ? (
                <Spinner className="size-3.5" />
              ) : (
                <RiAddLine className="size-3.5" />
              )}
              {isCreating ? "Creating…" : "Create canvas"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
