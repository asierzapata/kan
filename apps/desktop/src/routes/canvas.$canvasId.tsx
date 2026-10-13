import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RiAlertLine, RiArrowLeftLine } from "@remixicon/react";

import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel, ChatReopenButton } from "../components/ChatPanel";
import { AgentProvider } from "../components/agent-context";
import { CanvasProvider, useCanvas } from "../components/canvas-context";
import { WorkspacePanels } from "../components/WorkspacePanels";
import { useCanvasThumbnail } from "../components/use-canvas-thumbnail";
import { Spinner } from "../components/ui/spinner";
import {
  getCanvasEntry,
  touchCanvas,
  type CanvasCatalogEntry,
} from "@/lib/canvas-repository";

export const Route = createFileRoute("/canvas/$canvasId")({
  component: CanvasPage,
});

function CanvasPage() {
  const { canvasId } = Route.useParams();

  const [canvasEntry, setCanvasEntry] =
    React.useState<CanvasCatalogEntry | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [threadOpen, setThreadOpen] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    void getCanvasEntry(canvasId).then((entry) => {
      if (!active) return;
      setCanvasEntry(entry);
      setLoading(false);
      if (entry) {
        void touchCanvas(canvasId);
      }
    });
    return () => {
      active = false;
    };
  }, [canvasId]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setThreadOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (!canvasEntry) {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <RiAlertLine className="size-8 text-muted-foreground" />
        <h1 className="font-heading text-base font-medium text-foreground">
          Canvas Not Found
        </h1>
        <p className="text-xs text-muted-foreground max-w-sm">
          The requested offline canvas does not exist on this device or has been
          deleted.
        </p>
        <Link
          to="/"
          className="inline-flex items-center justify-center border border-border bg-background hover:bg-muted text-xs h-7 px-2.5 font-medium"
        >
          <RiArrowLeftLine className="size-4 mr-1.5" />
          Back to Canvases
        </Link>
      </main>
    );
  }

  return (
    <AgentProvider canvasId={canvasId}>
      <CanvasProvider>
        <CanvasPageContent
          canvasEntry={canvasEntry}
          canvasId={canvasId}
          threadOpen={threadOpen}
          setThreadOpen={setThreadOpen}
        />
      </CanvasProvider>
    </AgentProvider>
  );
}

function CanvasPageContent({
  canvasEntry,
  canvasId,
  threadOpen,
  setThreadOpen,
}: {
  canvasEntry: CanvasCatalogEntry;
  canvasId: string;
  threadOpen: boolean;
  setThreadOpen: (open: boolean) => void;
}) {
  const { editor } = useCanvas();
  useCanvasThumbnail(editor, canvasId);

  return (
    <div className="workspace">
      <HeaderBar title={canvasEntry.name} />
      <main className="workspace__body relative">
        <WorkspacePanels
          chatOpen={threadOpen}
          canvas={
            <Canvas roomId={canvasId} />
          }
          chat={
            <ChatPanel
              className="h-full w-full"
              roomId={canvasId}
              onClose={() => setThreadOpen(false)}
            />
          }
        />
        {!threadOpen ? <ChatReopenButton onClick={() => setThreadOpen(true)} /> : null}
      </main>
    </div>
  );
}
