import { assertActiveSession } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { canvasAccess } from "./http.ts";
import type { RoomManager } from "./rooms.ts";
import { dispatch } from "./runs.ts";

const FIRST_DELAY_MS = 100;
const PENDING_DELAY_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
const SWEEP_MS = 60_000;
const RECHECK_MS = 30_000;

const PENDING_CANVASES =
  "SELECT DISTINCT canvas FROM (SELECT t.canvas FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.status IN ('queued','running','dispatching','cancelling') UNION SELECT canvas FROM web_meeting_sessions WHERE status='listening' AND pending_cursor>processed_cursor) c LIMIT 100";

interface Slot {
  timer: NodeJS.Timeout | null;
  running: boolean;
  rearm: boolean;
  failures: number;
}

export interface SchedulerOptions {
  db: Database;
  config: Config;
  rooms: RoomManager;
  client: any;
  log?: Pick<Console, "error" | "warn" | "info">;
  now?: () => number;
  verifySession?: (user: string, sessionId: string) => Promise<void>;
}

export class Scheduler {
  private slots = new Map<string, Slot>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = true;
  private log: NonNullable<SchedulerOptions["log"]>;

  constructor(private opts: SchedulerOptions) {
    this.log = opts.log ?? console;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timers = [
      setInterval(() => void this.sweep(), SWEEP_MS),
      setInterval(() => void this.recheck(), RECHECK_MS),
    ];
    for (const timer of this.timers) timer.unref();
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
  }

  wake(canvas: string) {
    if (this.stopped) return;
    const slot = this.slot(canvas);
    if (slot.running) {
      slot.rearm = true;
      return;
    }
    if (slot.timer) return;
    this.arm(canvas, slot, FIRST_DELAY_MS);
  }

  async sweep() {
    try {
      const rows = (await this.opts.db.query(PENDING_CANVASES)).rows;
      for (const row of rows) this.wake(row.canvas);
    } catch (error) {
      this.log.error("server.sweep_failed", { name: (error as Error)?.name });
    }
  }

  async recheck() {
    const { rooms, db, config } = this.opts;
    const verify =
      this.opts.verifySession ?? ((user: string, sid: string) => assertActiveSession(config, user, sid));
    for (const handle of rooms.handles()) {
      for (const [sessionId, session] of [...handle.sessions]) {
        try {
          await verify(session.userId, session.authSessionId);
          const access = await db.transaction((tx) => canvasAccess(tx, handle.id, session.userId));
          if (access.role !== session.role) throw new Error("Role changed");
        } catch {
          rooms.kick(handle.id, sessionId, 1008, "Access expired");
        }
      }
    }
  }

  private slot(canvas: string) {
    let slot = this.slots.get(canvas);
    if (!slot) {
      slot = { timer: null, running: false, rearm: false, failures: 0 };
      this.slots.set(canvas, slot);
    }
    return slot;
  }

  private arm(canvas: string, slot: Slot, delay: number) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.run(canvas, slot);
    }, delay);
    slot.timer.unref();
  }

  private async run(canvas: string, slot: Slot) {
    if (this.stopped) return;
    slot.running = true;
    slot.rearm = false;
    const { db, config, client } = this.opts;
    const verify =
      this.opts.verifySession ?? ((user: string, sid: string) => assertActiveSession(config, user, sid));
    let next: number | null = null;
    try {
      const result = await dispatch(db, canvas, client, this.opts.now, verify, this.log);
      slot.failures = 0;
      if (result?.pending) next = PENDING_DELAY_MS;
    } catch (error) {
      slot.failures++;
      this.log.error("server.dispatch_failed", { canvas, name: (error as Error)?.name });
      next = Math.min(PENDING_DELAY_MS * 2 ** (slot.failures - 1), MAX_BACKOFF_MS);
    } finally {
      slot.running = false;
    }
    if (this.stopped) return;
    if (slot.rearm) next = FIRST_DELAY_MS;
    if (next !== null) this.arm(canvas, slot, next);
    else if (!slot.timer) this.slots.delete(canvas);
  }
}
