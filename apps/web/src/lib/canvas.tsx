import { Tldraw, useValue, defaultShapeUtils } from "tldraw";
import type { Editor } from "tldraw";
import { useSync } from "@tldraw/sync";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { useMemo, useState, useCallback, useRef } from "react";
import { createKanShapeUtils } from "../../../desktop/src/nodes/shapes";
import { createCanvasTools } from "../../../desktop/src/nodes/tools";
import "tldraw/tldraw.css";
import "../../../desktop/src/nodes/nodes.css";
const assetUrls = getAssetUrlsByImport();
function Selection({
  editor,
  onSelection,
}: {
  editor: Editor;
  onSelection: (ids: string[]) => void;
}) {
  const ids = useValue("selected shapes", () => editor.getSelectedShapeIds(), [
    editor,
  ]);
  // Selection context is viewer-local, never a document mutation.
  return (
    <button className="canvas-selection" onClick={() => onSelection(ids)}>
      Anchor {ids.length} selected nodes
    </button>
  );
}
export default function Canvas({
  canvas,
  onSelection,
  onAccessLost,
}: {
  canvas: string;
  onSelection: (ids: string[]) => void;
  onAccessLost: () => void;
}) {
  const shapeUtils = useMemo(
    () => [...defaultShapeUtils, ...createKanShapeUtils()],
    [],
  );
  const assets = useMemo(
    () => ({
      upload: async (_asset: any, file: File) => {
        if (file.size > 4 * 1024 * 1024)
          throw Error("Maximum upload is 4 MiB");
        const response = await fetch(`/api/assets?canvas=${canvas}`, {
          method: "POST",
          headers: { "content-type": file.type },
          body: file,
        });
        if (!response.ok) throw Error("Upload failed");
        return { src: (await response.json()).src };
      },
    }),
    [canvas],
  );
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  const socketUri = useCallback(async () => {
    const response = await fetch(`/api/web/room?canvas=${canvas}`);
    if (!response.ok) {
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      )
        accessLost.current();
      throw Error("Canvas access unavailable");
    }
    return (await response.json()).uri;
  }, [canvas]);
  const store = useSync({ uri: socketUri, assets, shapeUtils });
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw
        store={store}
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
        onMount={(editor) => {
          setEditor(editor);
          (window as any).__kanWeb = {
            editor,
            tools: createCanvasTools(editor),
          };
        }}
      />
      <div className="canvas-sync" role="status">
        {store.status}
        {"connectionStatus" in store ? ` · ${store.connectionStatus}` : ""}
      </div>
      {editor && <Selection editor={editor} onSelection={onSelection} />}
    </div>
  );
}
