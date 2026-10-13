/**
 * Removing a canvas from the catalog. Canvases exist only on this device, so
 * removing one destroys it. Nothing is recoverable afterwards; the caller is
 * responsible for confirming first.
 */
import {
  deleteCanvasDocument,
  deleteCanvasEntry,
  getCanvasEntry,
} from "./canvas-repository";
import { deleteLocalThread } from "./local-thread-store";

/**
 * Everything derived from a canvas that this device stores separately from the
 * catalog entry. Each is best-effort: the entry is already gone by the time we
 * get here, so a failure leaks storage rather than stranding a card the user
 * cannot remove. Failing the whole call would be worse — it would suggest the
 * canvas is still there when it is not.
 */
async function deleteCanvasPayload(entry: {
  id: string;
  localPersistenceKey: string;
}): Promise<void> {
  const cleanups: [string, Promise<unknown>][] = [
    ["canvas document", deleteCanvasDocument(entry.localPersistenceKey)],
    ["thread", deleteLocalThread(entry.id)],
  ];
  for (const [what, work] of cleanups) {
    try {
      await work;
    } catch (err) {
      console.warn(`Could not delete the ${what} for canvas ${entry.id}:`, err);
    }
  }
}

export async function deleteCanvas(id: string): Promise<void> {
  const entry = await getCanvasEntry(id);
  if (!entry) throw new Error(`Canvas ${id} not found in catalog`);
  await deleteCanvasEntry(entry.id);
  await deleteCanvasPayload(entry);
}
