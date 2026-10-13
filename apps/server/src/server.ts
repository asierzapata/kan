import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createAdaptorServer } from "@hono/node-server";
import type { Persistence } from "@kan/web-core/persistence";
import { createApp } from "./app.ts";
import { assertActiveSession } from "./auth.ts";
import { createAssetStore, type AssetStore } from "./assets.ts";
import { canvasAccess } from "./http.ts";
import { agentClient } from "./runs.ts";
import { Scheduler } from "./scheduler.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { RoomManager } from "./rooms.ts";
import { schema } from "./schema.ts";
import { attachSync } from "./sync.ts";
import type { TicketClaims } from "./tickets.ts";

export interface CreateServerOptions {
  config: Config;
  db: Database;
  persistence: Persistence;
  sqlite: DatabaseSync;
  authorize?: (claims: TicketClaims) => Promise<{ role: string }>;
  assets?: AssetStore;
  auth?: { activeAuth(request: Request): Promise<import("./auth.ts").Auth> };
  client?: any;
  flushMs?: number;
  idleMs?: number;
}

export function createServer(opts: CreateServerOptions) {
  const { config, db, persistence, sqlite } = opts;
  const rooms = new RoomManager({
    db,
    persistence,
    sqlite,
    schema,
    flushMs: opts.flushMs,
    idleMs: opts.idleMs,
  });
  const client = opts.client !== undefined ? opts.client : agentClient(config);
  const scheduler = new Scheduler({ db, config, rooms, client });
  const assets = opts.assets ?? createAssetStore(config);
  const app = createApp({ config, db, persistence, rooms, scheduler, assets, auth: opts.auth, client });
  const authorize =
    opts.authorize ??
    (async (claims: TicketClaims) => {
      await assertActiveSession(config, claims.sub, claims.sessionId);
      return db.transaction((tx) => canvasAccess(tx, claims.room, claims.sub));
    });
  const server = createAdaptorServer({ fetch: app.fetch }) as unknown as Server;
  const sync = attachSync(server, {
    rooms,
    secret: config.KAN_SERVICE_SECRET,
    allowedOrigin: new URL(config.KAN_PUBLIC_URL).origin,
    authorize,
  });
  rooms.start();
  scheduler.start();
  return {
    server,
    rooms,
    scheduler,
    app,
    listen: (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve((server.address() as { port: number }).port));
      }),
    async close() {
      scheduler.stop();
      sync.close();
      await rooms.close();
      if (server.listening)
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
    },
  };
}
