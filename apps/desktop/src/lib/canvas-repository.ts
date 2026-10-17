export interface CanvasCatalogEntry {
  id: string;
  name: string;
  /** `online` only appears on entries written before online rooms were removed. */
  mode: "offline" | "online";
  localPersistenceKey: string;
  roomId?: string;
  roomCode?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  initialRecords?: unknown[];
  /** Data URL of the last preview rendered from this canvas, for the catalog. */
  thumbnail?: string;
  thumbnailUpdatedAt?: string;
}

const DB_NAME = "kan-catalog";
const DB_VERSION = 1;
const CANVASES_STORE = "canvases";
const JOURNAL_STORE = "publish_journal";

function openCatalogDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CANVASES_STORE)) {
        const store = db.createObjectStore(CANVASES_STORE, { keyPath: "id" });
        store.createIndex("mode", "mode", { unique: false });
        store.createIndex("lastOpenedAt", "lastOpenedAt", { unique: false });
        store.createIndex("roomId", "roomId", { unique: false });
      }
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        db.createObjectStore(JOURNAL_STORE, { keyPath: "localCanvasId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open catalog database"));
  });
}

export async function listLocalCanvases(): Promise<CanvasCatalogEntry[]> {
  try {
    const db = await openCatalogDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CANVASES_STORE, "readonly");
      const store = tx.objectStore(CANVASES_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as CanvasCatalogEntry[]) ?? [];
        items.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
        resolve(items);
      };
      req.onerror = () => reject(req.error ?? new Error("Failed to list canvases"));
    });
  } catch (err) {
    console.warn("Could not read canvases from storage:", err);
    return [];
  }
}

export async function getCanvasEntry(id: string): Promise<CanvasCatalogEntry | null> {
  try {
    const db = await openCatalogDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CANVASES_STORE, "readonly");
      const store = tx.objectStore(CANVASES_STORE);
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) {
          resolve(req.result as CanvasCatalogEntry);
          return;
        }
        // Fallback check by roomId
        const index = store.index("roomId");
        const roomReq = index.get(id);
        roomReq.onsuccess = () => resolve((roomReq.result as CanvasCatalogEntry) ?? null);
        roomReq.onerror = () => resolve(null);
      };
      req.onerror = () => reject(req.error ?? new Error(`Failed to get canvas ${id}`));
    });
  } catch (err) {
    console.warn(`Could not read canvas ${id}:`, err);
    return null;
  }
}

export async function saveCanvasEntry(entry: CanvasCatalogEntry): Promise<CanvasCatalogEntry> {
  const db = await openCatalogDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVASES_STORE, "readwrite");
    const store = tx.objectStore(CANVASES_STORE);
    const req = store.put(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror = () => reject(req.error ?? new Error(`Failed to save canvas ${entry.id}`));
  });
}

export async function renameCanvas(id: string, name: string): Promise<CanvasCatalogEntry> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Canvas name cannot be empty");

  const existing = await getCanvasEntry(id);
  if (!existing) throw new Error(`Canvas ${id} not found in catalog`);

  return saveCanvasEntry({
    ...existing,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  });
}

export async function createOfflineCanvas(params?: {
  id?: string;
  name?: string;
  initialRecords?: unknown[];
}): Promise<CanvasCatalogEntry> {
  const id = params?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const entry: CanvasCatalogEntry = {
    id,
    name: params?.name?.trim() || "Untitled Canvas",
    mode: "offline",
    localPersistenceKey: `kan-room-${id}`,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    initialRecords: params?.initialRecords,
  };
  return saveCanvasEntry(entry);
}

export async function consumeCanvasInitialRecords(id: string): Promise<unknown[] | null> {
  const entry = await getCanvasEntry(id);
  if (!entry?.initialRecords?.length) return null;
  const records = entry.initialRecords;
  const rest = { ...entry };
  delete rest.initialRecords;
  await saveCanvasEntry(rest);
  return records;
}

/**
 * Previews are captured from a live editor, so they only exist for canvases
 * this device has actually opened. A miss is normal, never an error.
 */
export async function saveCanvasThumbnail(
  id: string,
  thumbnail: string
): Promise<void> {
  try {
    const existing = await getCanvasEntry(id);
    if (!existing) return;
    await saveCanvasEntry({
      ...existing,
      thumbnail,
      thumbnailUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`Could not store preview for canvas ${id}:`, err);
  }
}

export async function touchCanvas(id: string): Promise<void> {
  const existing = await getCanvasEntry(id);
  if (!existing) return;
  existing.lastOpenedAt = new Date().toISOString();
  await saveCanvasEntry(existing);
}

export async function deleteCanvasEntry(id: string): Promise<void> {
  const db = await openCatalogDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVASES_STORE, "readwrite");
    const store = tx.objectStore(CANVASES_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`Failed to delete canvas ${id}`));
  });
}

/**
 * tldraw stores each canvas in its own IndexedDB database named after the
 * persistence key, and keeps a registry of those names in localStorage. It
 * exposes no per-document delete, so we do both halves here. Leaving the
 * registry entry behind would leave tldraw listing a database that no longer
 * exists.
 */
const TLDRAW_DB_PREFIX = "TLDRAW_DOCUMENT_v2";
const TLDRAW_DB_NAME_INDEX = "TLDRAW_DB_NAME_INDEX_v2";

export async function deleteCanvasDocument(localPersistenceKey: string): Promise<void> {
  const dbName = `${TLDRAW_DB_PREFIX}${localPersistenceKey}`;

  if (typeof localStorage !== "undefined") {
    try {
      const names = JSON.parse(localStorage.getItem(TLDRAW_DB_NAME_INDEX) || "[]") as unknown;
      if (Array.isArray(names)) {
        localStorage.setItem(
          TLDRAW_DB_NAME_INDEX,
          JSON.stringify(names.filter((name) => name !== dbName)),
        );
      }
    } catch (err) {
      console.warn(`Could not prune the tldraw database index for ${dbName}:`, err);
    }
  }

  if (typeof indexedDB === "undefined") return;

  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    if (!req) {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    // A still-open editor connection blocks the delete, and an error leaves the
    // database in place. Neither should strand the user with an undeletable
    // card, so both resolve: the catalog entry is already gone by this point.
    req.onblocked = () => {
      console.warn(`Deleting ${dbName} is blocked by an open connection`);
      resolve();
    };
    req.onerror = () => {
      console.warn(`Could not delete ${dbName}:`, req.error);
      resolve();
    };
  });
}
