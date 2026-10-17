import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom, type RoomSnapshot } from "@tldraw/sync-core";
import type { UnknownRecord } from "@tldraw/store";
import type { Persistence } from "@kan/web-core/persistence";
import type { Database } from "./database.ts";
import { HttpError } from "./http.ts";
import { planRevert, planTool } from "./planner.ts";

export type Role = "owner" | "editor" | "viewer";

export interface RoomSession {
  userId: string;
  authSessionId: string;
  role: Role;
  socket: WebSocket;
}

export interface RoomHandle {
  id: string;
  room: TLSocketRoom<UnknownRecord, { userId: string }>;
  storage: SQLiteSyncStorage<UnknownRecord>;
  assetIds: Set<string>;
  lastActivity: number;
  revision(): number;
  sessions: Map<string, RoomSession>;
  tail: Promise<unknown>;
  lastPersisted: number;
  timer: NodeJS.Timeout | null;
  retryMs: number;
  busy: number;
  closed: boolean;
  pendingLabel: FlushLabel | null;
}

export interface ToolCommand {
  name: string;
  input: any;
  operation: string;
  run?: string;
  user: string;
  session?: string;
  expectedRevision?: number;
  diagram?: unknown;
}

export interface RoomManagerOptions {
  db: Database;
  persistence: Persistence;
  sqlite: DatabaseSync;
  schema: any;
  flushMs?: number;
  idleMs?: number;
  log?: Pick<Console, "error" | "warn" | "info">;
}

interface FlushLabel {
  operation: string;
  input: unknown;
}

const ASSET_SRC = /^\/api\/assets\?id=([0-9a-f-]{36})$/;
const FOREIGN_ASSET = "Asset belongs to another canvas";
const INVALID_IMAGE = "Invalid image URL";

function assetId(src: string) {
  const match = ASSET_SRC.exec(src);
  if (match) return match[1];
  if (!src.startsWith("https://")) return null;
  try {
    const url = new URL(src);
    return url.pathname === "/api/assets" ? (url.searchParams.get("id") ?? "") : null;
  } catch {
    return null;
  }
}

export function srcError(assetIds: Set<string>, src: unknown): string | null {
  if (typeof src !== "string") return INVALID_IMAGE;
  const id = assetId(src);
  if (id !== null) return assetIds.has(id) ? null : FOREIGN_ASSET;
  return src.startsWith("https://") ? null : INVALID_IMAGE;
}

const checksSrc = (record: any) =>
  record?.typeName === "asset" || (record?.typeName === "shape" && record.type === "kan-image");
const CANVAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RoomManager {
  private rooms = new Map<string, RoomHandle>();
  private opening = new Map<string, Promise<RoomHandle>>();
  private closing = new Map<string, Promise<void>>();
  private interval: NodeJS.Timeout | null = null;
  private emptySnapshot: RoomSnapshot | null = null;
  private flushMs: number;
  private idleMs: number;
  private log: NonNullable<RoomManagerOptions["log"]>;

  constructor(private opts: RoomManagerOptions) {
    this.flushMs = opts.flushMs ?? 500;
    this.idleMs = opts.idleMs ?? 60_000;
    this.log = opts.log ?? console;
  }

  start() {
    this.interval ??= setInterval(() => void this.tick(), 10_000);
    this.interval.unref();
  }

  get(canvasId: string) {
    return this.rooms.get(canvasId);
  }

  handles() {
    return [...this.rooms.values()];
  }

  open(canvasId: string): Promise<RoomHandle> {
    const existing = this.rooms.get(canvasId);
    if (existing) return Promise.resolve(existing);
    let pending = this.opening.get(canvasId);
    if (!pending) {
      pending = (async () => {
        await this.closing.get(canvasId);
        return this.load(canvasId);
      })().finally(() => this.opening.delete(canvasId));
      this.opening.set(canvasId, pending);
    }
    return pending;
  }

  private initialSnapshot() {
    if (!this.emptySnapshot) {
      const scratch = new TLSocketRoom({ schema: this.opts.schema });
      this.emptySnapshot = scratch.getCurrentSnapshot();
      scratch.close();
    }
    return this.emptySnapshot;
  }

  private async load(canvasId: string): Promise<RoomHandle> {
    if (!CANVAS_ID.test(canvasId)) throw new HttpError(404, "Canvas unavailable");
    const { persistence, db, sqlite, schema } = this.opts;
    const wrapper = new NodeSqliteWrapper(sqlite as never, {
      tablePrefix: `room_${canvasId.replace(/-/g, "_")}_`,
    });
    const row = await persistence.load(canvasId, this.initialSnapshot());
    const local = SQLiteSyncStorage.hasBeenInitialized(wrapper)
      ? SQLiteSyncStorage.getDocumentClock(wrapper)
      : null;
    const seeded = !(local !== null && local >= row.revision);
    const storage = new SQLiteSyncStorage<UnknownRecord>({
      sql: wrapper,
      snapshot: seeded ? row.snapshot : undefined,
    });
    this.log.info("server.room_loaded", {
      canvas: canvasId,
      source: seeded ? "postgres" : "local",
      persisted: row.revision,
      local,
    });
    const assetIds = new Set<string>(
      (await db.query("SELECT id FROM web_assets WHERE canvas=$1", [canvasId])).rows.map(
        (r) => r.id as string,
      ),
    );
    const handle = {
      id: canvasId,
      storage,
      assetIds,
      lastActivity: Date.now(),
      revision: () => storage.getClock(),
      sessions: new Map(),
      tail: Promise.resolve(),
      lastPersisted: row.revision,
      timer: null,
      retryMs: 0,
      busy: 0,
      closed: false,
      pendingLabel: null,
    } as unknown as RoomHandle;
    handle.room = new TLSocketRoom<UnknownRecord, { userId: string }>({
      storage,
      schema,
      log: {
        error: (...args: unknown[]) => this.log.error("server.sync_error", ...args),
        warn: (...args: unknown[]) => this.log.warn("server.sync_rejected", ...args),
      },
      authorizeRecord: {
        asset: ({ next, prev }) => {
          if (!next) return prev;
          const src = (next as unknown as { props?: { src?: unknown } }).props?.src;
          return srcError(handle.assetIds, src) === null ? next : null;
        },
        shape: ({ next, prev }) => {
          if (!next) return prev;
          if ((next as any).type !== "kan-image") return next;
          const src = (next as unknown as { props?: { src?: unknown } }).props?.src;
          return srcError(handle.assetIds, src) === null ? next : null;
        },
      },
      onSessionRemoved: () => {
        handle.lastActivity = Date.now();
      },
    });
    storage.onChange(() => this.scheduleFlush(handle));
    this.rooms.set(canvasId, handle);
    if (storage.getClock() > handle.lastPersisted) this.scheduleFlush(handle, 0);
    return handle;
  }

  async connect(
    canvasId: string,
    ws: WebSocket,
    info: { sessionId: string; userId: string; authSessionId: string; role: Role },
  ) {
    const handle = await this.open(canvasId);
    handle.lastActivity = Date.now();
    handle.sessions.set(info.sessionId, {
      userId: info.userId,
      authSessionId: info.authSessionId,
      role: info.role,
      socket: ws,
    });
    handle.room.handleSocketConnect({
      sessionId: info.sessionId,
      socket: ws as never,
      isReadonly: info.role === "viewer",
      meta: { userId: info.userId },
    });
    ws.on("close", () => {
      handle.sessions.delete(info.sessionId);
      handle.room.handleSocketClose(info.sessionId);
    });
    ws.on("error", () => {
      handle.sessions.delete(info.sessionId);
      handle.room.handleSocketError(info.sessionId);
    });
  }

  kick(canvasId: string, sessionId: string, code = 1008, reason = "Access revoked") {
    this.rooms.get(canvasId)?.sessions.get(sessionId)?.socket.close(code, reason);
  }

  registerAsset(canvasId: string, assetId: string) {
    this.rooms.get(canvasId)?.assetIds.add(assetId);
  }

  private enqueue<T>(handle: RoomHandle, fn: () => Promise<T>): Promise<T> {
    handle.busy++;
    const job = handle.tail.then(fn);
    handle.tail = job.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      handle.busy--;
    });
    return job;
  }

  private scheduleFlush(handle: RoomHandle, delay = this.flushMs) {
    if (handle.closed) return;
    if (handle.timer) clearTimeout(handle.timer);
    handle.timer = setTimeout(() => {
      handle.timer = null;
      this.enqueue(handle, () => this.flush(handle)).then(
        () => {
          handle.retryMs = 0;
        },
        (error) => this.flushFailed(handle, error),
      );
    }, delay);
  }

  private flushFailed(handle: RoomHandle, error: unknown) {
    this.log.error("server.flush_failed", { canvas: handle.id, name: (error as Error)?.name });
    handle.retryMs = Math.min(Math.max(handle.retryMs * 2, 1000), 30_000);
    this.scheduleFlush(handle, handle.retryMs);
  }

  private async flush(handle: RoomHandle, requested?: FlushLabel) {
    const label = requested ?? handle.pendingLabel ?? undefined;
    const snapshot = handle.storage.getSnapshot();
    const clock = snapshot.documentClock ?? 0;
    if (clock <= handle.lastPersisted && !label) return;
    const { documents, ...metadata } = snapshot;
    const since = handle.lastPersisted;
    await this.opts.persistence.persist(handle.id, {
      revision: clock,
      metadata,
      puts: documents.filter((d) => d.lastChangedClock > since),
      removes: Object.entries(snapshot.tombstones ?? {})
        .filter(([, c]) => c > since)
        .map(([id]) => id),
      operation: label?.operation ?? `sync:${clock}`,
      input: label?.input ?? null,
    });
    handle.lastPersisted = clock;
    this.log.info("server.flush", {
      canvas: handle.id,
      revision: clock,
      operation: label?.operation ?? null,
      puts: documents.filter((d) => d.lastChangedClock > since).length,
    });
    if (label && handle.pendingLabel?.operation === label.operation) handle.pendingLabel = null;
  }

  async applyTool(canvasId: string, command: ToolCommand) {
    const handle = await this.open(canvasId);
    handle.lastActivity = Date.now();
    return this.enqueue(handle, async () => {
      const { persistence } = this.opts;
      const actor = { user: command.user, run: command.run, session: command.session };
      const input = { name: command.name, input: command.input, actor };
      const prior = await persistence.receipt(canvasId, command.operation, input);
      if (prior)
        return {
          duplicate: true,
          revision: handle.revision(),
          committedRevision: prior.revision as number,
          shapeIds: prior.changes.puts
            .filter((doc: any) => doc.state.typeName === "shape")
            .map((doc: any) => doc.state.id as string),
          removed: prior.changes.removes as string[],
        };
      if (command.name === "getCanvas")
        return { ...planTool(handle.room, this.opts.schema, command).result, revision: handle.revision() };
      await persistence.assertActor(canvasId, actor);
      await this.flush(handle);
      if (command.expectedRevision !== undefined && command.expectedRevision !== handle.revision())
        throw new HttpError(409, "Stale agent revision; read canvas again");
      const plan =
        command.name === "revertRun"
          ? planRevert(handle.room, command.input?.candidates)
          : planTool(handle.room, this.opts.schema, command);
      for (const record of plan.puts) {
        if (!checksSrc(record)) continue;
        const error = srcError(handle.assetIds, record.props?.src);
        if (error) throw new HttpError(400, error);
      }
      if (plan.puts.length || plan.removes.length)
        await handle.room.updateStore((store) => {
          plan.removes.forEach((id: string) => store.delete(id));
          plan.puts.forEach((record: any) => store.put(record));
        });
      try {
        await this.flush(handle, { operation: command.operation, input });
      } catch (error) {
        handle.pendingLabel = { operation: command.operation, input };
        this.flushFailed(handle, error);
        throw error;
      }
      return { ...plan.result, revision: handle.revision() };
    });
  }

  async tick(now = Date.now()) {
    for (const handle of [...this.rooms.values()]) {
      if (
        handle.room.getNumActiveSessions() === 0 &&
        !handle.timer &&
        handle.busy === 0 &&
        now - handle.lastActivity > this.idleMs
      )
        await this.closeRoom(handle.id).catch(() => {});
    }
  }

  closeRoom(canvasId: string): Promise<void> {
    const handle = this.rooms.get(canvasId);
    if (!handle) return this.closing.get(canvasId) ?? Promise.resolve();
    const closing = (async () => {
      if (handle.timer) clearTimeout(handle.timer);
      handle.timer = null;
      try {
        await this.enqueue(handle, () => this.flush(handle));
      } finally {
        handle.closed = true;
        (handle.storage as unknown as { pruneTombstones?: { cancel?(): void } }).pruneTombstones?.cancel?.();
        handle.room.close();
        this.rooms.delete(canvasId);
      }
    })().finally(() => this.closing.delete(canvasId));
    this.closing.set(canvasId, closing);
    return closing;
  }

  async close() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.rooms.keys()].map((id) => this.closeRoom(id)));
  }
}
