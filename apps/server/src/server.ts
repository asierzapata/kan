import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createAdaptorServer } from "@hono/node-server";
import type { Persistence } from "@kan/web-core/persistence";
import { createApp } from "./app.ts";
import { createAuth, type AuthService } from "./auth.ts";
import type { Kysely } from "kysely";
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
  kysely: Kysely<any>;
  auth?: AuthService;
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
  const auth = opts.auth ?? createAuth(config, opts.kysely);
  const verifySession = async (user: string, session: string) => {
    if (auth.assertActiveSession) await auth.assertActiveSession(user, session);
  };
  const scheduler = new Scheduler({ db, config, rooms, client, verifySession });
  const assets = opts.assets ?? createAssetStore(config);
  const app = createApp({ config, db, persistence, rooms, scheduler, assets, auth, client });
  const authorize =
    opts.authorize ??
    (async (claims: TicketClaims) => {
      await verifySession(claims.sub, claims.sessionId);
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
