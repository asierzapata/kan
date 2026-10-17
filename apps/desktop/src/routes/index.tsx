import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RiAddLine } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { CreateCanvasDialog } from "@/components/CreateCanvasDialog";
import { DeleteCanvasDialog } from "@/components/DeleteCanvasDialog";
import { KanBrand } from "@/components/KanBrand";
import {
  CanvasCard,
  CanvasRenameEditor,
  type CanvasCardItem,
} from "@/components/CanvasCard";

import { getInstallationProfile } from "@/lib/installation-profile";
import {
  listLocalCanvases,
  renameCanvas,
  type CanvasCatalogEntry,
} from "@/lib/canvas-repository";
import { deleteCanvas } from "@/lib/delete-canvas";

export const Route = createFileRoute("/")({
  component: CatalogPage,
});

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMinutes = Math.floor((Date.now() - d.getTime()) / 60000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function toItems(locals: CanvasCatalogEntry[]): CanvasCardItem[] {
  return locals
    .filter((local) => local.mode === "offline")
    .map((local) => ({
      id: local.id,
      name: local.name,
      lastActivity: local.lastOpenedAt || local.updatedAt,
      thumbnail: local.thumbnail,
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

function CatalogPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = React.useState(true);
  const [userName, setUserName] = React.useState("");
  const [localCanvases, setLocalCanvases] = React.useState<CanvasCatalogEntry[]>([]);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [renameTargetId, setRenameTargetId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [removeTargetId, setRemoveTargetId] = React.useState<string | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [isRemoving, setIsRemoving] = React.useState(false);

  const refreshCatalog = React.useCallback(async () => {
    const profile = await getInstallationProfile();
    if (
      !profile ||
      !profile.onboardingCompletedAt ||
      !profile.name ||
      profile.onboardingVersion < 2
    ) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    setUserName(profile.name);

    const locals = await listLocalCanvases();
    setLocalCanvases(locals);
    setLoading(false);
  }, [navigate]);

  React.useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const items = React.useMemo(() => toItems(localCanvases), [localCanvases]);

  const openItem = (item: CanvasCardItem) => {
    void navigate({ to: "/canvas/$canvasId", params: { canvasId: item.id } });
  };

  const beginRemove = (item: CanvasCardItem) => {
    if (isRemoving) return;
    setRemoveTargetId(item.id);
    setRemoveError(null);
  };

  const cancelRemove = () => {
    if (isRemoving) return;
    setRemoveTargetId(null);
    setRemoveError(null);
  };

  const handleRemove = async () => {
    const target = items.find((item) => item.id === removeTargetId);
    if (!target) return;

    setIsRemoving(true);
    setRemoveError(null);
    try {
      await deleteCanvas(target.id);
      setLocalCanvases((canvases) =>
        canvases.filter((canvas) => canvas.id !== target.id),
      );
      setRemoveTargetId(null);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : "Failed to remove canvas",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  const beginRename = (item: CanvasCardItem) => {
    if (isRenaming) return;
    setRenameTargetId(item.id);
    setRenameDraft(item.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    if (isRenaming) return;
    setRenameTargetId(null);
    setRenameDraft("");
    setRenameError(null);
  };

  const handleRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = items.find((item) => item.id === renameTargetId);
    if (!target) return;

    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenameError("Canvas name cannot be empty");
      return;
    }

    setIsRenaming(true);
    setRenameError(null);
    try {
      const updated = await renameCanvas(target.id, trimmed);
      setLocalCanvases((canvases) =>
        canvases.map((canvas) => (canvas.id === updated.id ? updated : canvas)),
      );

      setRenameTargetId(null);
      setRenameDraft("");
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Failed to rename canvas",
      );
    } finally {
      setIsRenaming(false);
    }
  };

  const removeTarget = items.find((item) => item.id === removeTargetId);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background">
      <header className="header-bar sticky top-0 z-20 shrink-0">
        <div className="header-bar__brand flex items-center gap-2">
          <KanBrand />
          {userName ? (
            <span className="border-l border-border pl-3 font-sans text-sm font-normal text-muted-foreground">
              {userName}
            </span>
          ) : null}
        </div>

        <div className="header-bar__slot" />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => setCreateDialogOpen(true)}
            className="h-7 gap-1.5"
          >
            <RiAddLine className="size-3.5" />
            New canvas
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 p-6 md:p-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="font-sans text-[28px] font-semibold tracking-tight text-foreground">
              Canvases
            </h1>
            <p className="font-sans text-sm text-muted-foreground">
              Kept on this device.
            </p>
          </div>
        </div>

        {items.length === 0 ? (
          <Empty className="border border-border py-12">
            <EmptyMedia variant="icon">
              <RiAddLine />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No canvases yet</EmptyTitle>
              <EmptyDescription>Create one to start sketching.</EmptyDescription>
            </EmptyHeader>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => setCreateDialogOpen(true)}
                className="gap-1.5 text-xs"
              >
                <RiAddLine className="size-3.5" />
                New canvas
              </Button>
            </div>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <CanvasCard
                key={item.id}
                item={item}
                formatDate={formatDate}
                onOpen={() => openItem(item)}
                onRename={() => beginRename(item)}
                onRemove={() => beginRemove(item)}
                isRenaming={isRenaming}
                isRemoving={isRemoving && removeTargetId === item.id}
                renameEditor={
                  renameTargetId === item.id ? (
                    <CanvasRenameEditor
                      value={renameDraft}
                      onChange={setRenameDraft}
                      onSubmit={(event) => void handleRename(event)}
                      onCancel={cancelRename}
                      busy={isRenaming}
                      error={renameError}
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </main>

      <CreateCanvasDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={(canvas) => {
          setCreateDialogOpen(false);
          void navigate({
            to: "/canvas/$canvasId",
            params: { canvasId: canvas.localCanvasId },
          });
        }}
      />

      <DeleteCanvasDialog
        open={removeTarget !== undefined}
        name={removeTarget?.name ?? ""}
        busy={isRemoving}
        error={removeError}
        onConfirm={() => void handleRemove()}
        onCancel={cancelRemove}
      />
    </div>
  );
}
