import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB } from "./mock-idb";
import {
  createOfflineCanvas,
  getCanvasEntry,
} from "../src/lib/canvas-repository";
import { localThreadStorage } from "../src/lib/local-thread-store";
import { completeOnboarding } from "../src/lib/onboarding";
import { deleteCanvas } from "../src/lib/delete-canvas";

const TLDRAW_DB_NAME_INDEX = "TLDRAW_DB_NAME_INDEX_v2";

/** Enough of the Storage API for the tldraw database-name registry. */
function setupMockLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
    writable: true,
    configurable: true,
  });
  return data;
}

function threadEntry(text: string) {
  return {
    id: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    seq: 1,
    at: "2026-09-19T12:00:00.000Z",
    kind: "message" as const,
    text,
    authorId: crypto.randomUUID(),
    anchors: [],
    attachments: [],
  };
}

beforeEach(() => setupMockIndexedDB());

test("deleting an offline canvas removes every local trace without touching the network", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network request");
  });
  const canvas = await createOfflineCanvas({ name: "Sketch" });
  await localThreadStorage.write(canvas.id, [threadEntry("hello")]);
  const store = setupMockLocalStorage({
    [TLDRAW_DB_NAME_INDEX]: JSON.stringify([
      `TLDRAW_DOCUMENT_v2${canvas.localPersistenceKey}`,
      "TLDRAW_DOCUMENT_v2kan-room-other",
    ]),
  });
  const deleted: string[] = [];
  const realDelete = indexedDB.deleteDatabase.bind(indexedDB);
  t.mock.method(indexedDB, "deleteDatabase", (name: string) => {
    deleted.push(name);
    return realDelete(name);
  });

  await deleteCanvas(canvas.id);

  assert.equal(await getCanvasEntry(canvas.id), null);
  assert.deepEqual(await localThreadStorage.read(canvas.id), []);
  assert.deepEqual(deleted, [`TLDRAW_DOCUMENT_v2${canvas.localPersistenceKey}`]);
  assert.deepEqual(JSON.parse(store.get(TLDRAW_DB_NAME_INDEX)!), [
    "TLDRAW_DOCUMENT_v2kan-room-other",
  ]);
});

test("deleting one offline canvas leaves the others alone", async () => {
  setupMockLocalStorage();
  const kept = await createOfflineCanvas({ name: "Kept" });
  const doomed = await createOfflineCanvas({ name: "Doomed" });
  await localThreadStorage.write(kept.id, [threadEntry("still here")]);

  await deleteCanvas(doomed.id);

  assert.deepEqual(await getCanvasEntry(kept.id), kept);
  assert.equal((await localThreadStorage.read(kept.id)).length, 1);
});

test("deleting a missing canvas is refused", async () => {
  setupMockLocalStorage();
  await assert.rejects(deleteCanvas("missing"), /not found/i);
});
