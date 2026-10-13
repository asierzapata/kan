/**
 * One canvas in the catalog grid.
 *
 * The preview is whatever the last editing session rendered, so a canvas this
 * device has never opened has none. Rather than an empty hole, those fall back
 * to a tinted monogram keyed off the name, which at least stays stable between
 * visits and reads as "not yet opened" rather than "empty".
 */
import * as React from "react";
import {
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiHardDriveLine,
  RiTimeLine,
} from "@remixicon/react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { cn } from "@/lib/utils";

export interface CanvasCardItem {
  id: string;
  name: string;
  lastActivity: string;
  thumbnail?: string;
}

export interface CanvasCardProps {
  item: CanvasCardItem;
  formatDate: (iso: string) => string;
  onOpen: () => void;
  onRename: () => void;
  onRemove: () => void;
  isRenaming?: boolean;
  isRemoving?: boolean;
  /** When set, the title is replaced by this editor. */
  renameEditor?: React.ReactNode;
}

const MONOGRAM_TINTS = [
  "bg-primary/10 text-primary",
  "bg-emerald-500/10 text-emerald-600",
  "bg-amber-500/10 text-amber-600",
  "bg-violet-500/10 text-violet-600",
  "bg-sky-500/10 text-sky-600",
  "bg-rose-500/10 text-rose-600",
];

function tintFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return MONOGRAM_TINTS[hash % MONOGRAM_TINTS.length];
}

function monogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function CanvasCard({
  item,
  formatDate,
  onOpen,
  onRename,
  onRemove,
  isRenaming = false,
  isRemoving = false,
  renameEditor,
}: CanvasCardProps) {
  return (
    <article
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs transition-[border-color,box-shadow] duration-200 hover:border-foreground/20 hover:shadow-md focus-within:border-ring"
      aria-label={item.name}
      data-mode="offline"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${item.name}`}
        className="relative block aspect-4/3 w-full overflow-hidden border-b border-border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt=""
            className="size-full object-cover object-top"
            draggable={false}
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-full items-center justify-center font-heading text-2xl font-bold",
              tintFor(item.name),
            )}
          >
            {monogram(item.name)}
          </span>
        )}

        <span
          className={cn(
            "absolute left-3 top-3 inline-flex items-center gap-1 rounded-md bg-card/95 px-2 py-1 text-xs font-medium text-muted-foreground shadow-xs",
          )}
        >
          <RiHardDriveLine className="size-3" />
          Offline
        </span>
      </button>

      <div className="flex min-w-0 flex-col gap-2 p-4">
        {renameEditor ?? (
          <button
            type="button"
            onClick={onOpen}
            className="truncate text-left font-sans text-base font-semibold tracking-tight text-foreground hover:underline"
            title={item.name}
          >
            {item.name}
          </button>
        )}

        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <RiTimeLine className="size-3 shrink-0" />
          <span className="truncate">{formatDate(item.lastActivity)}</span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={onRename}
            disabled={isRenaming}
            className="gap-1 text-xs"
          >
            <RiEditLine className="size-3" />
            Rename
          </Button>

          {/* Last and set apart, so the irreversible one is not adjacent to
              Rename in the tab order or under a mis-aimed click. */}
          <Button
            size="xs"
            variant="ghost"
            onClick={onRemove}
            disabled={isRemoving}
            className="ml-auto gap-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete this canvas from this device"
          >
            {isRemoving ? (
              <Spinner className="size-3" />
            ) : (
              <RiDeleteBinLine className="size-3" />
            )}
            Delete
          </Button>
        </div>
      </div>
    </article>
  );
}

/** Shared by both the card title and the rename form, so Escape behaves once. */
export function CanvasRenameEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <form className="flex min-w-0 flex-wrap items-center gap-1" onSubmit={onSubmit}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label="Canvas name"
        aria-invalid={Boolean(error)}
        autoFocus
        maxLength={120}
        disabled={busy}
        className="h-6 w-0 min-w-0 flex-1 font-heading"
      />
      <Button
        type="submit"
        size="icon-xs"
        variant="ghost"
        aria-label="Save canvas name"
        title="Save canvas name"
        disabled={busy}
      >
        <RiCheckLine />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Cancel renaming"
        title="Cancel renaming"
        onClick={onCancel}
        disabled={busy}
      >
        <RiCloseLine />
      </Button>
      {error ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
