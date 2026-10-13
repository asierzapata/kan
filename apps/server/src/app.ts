import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Persistence } from "@kan/web-core/persistence";
import type { AuthService } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { createApi } from "./api.ts";
import type { AssetStore } from "./assets.ts";
import { createAssetRoutes } from "./asset-routes.ts";
import { HttpError } from "./http.ts";
import type { RoomManager } from "./rooms.ts";
import type { Scheduler } from "./scheduler.ts";

export interface AppContext {
  config: Config;
  db: Database;
  persistence: Persistence;
  rooms: RoomManager;
  scheduler: Pick<Scheduler, "wake">;
  assets: AssetStore;
  auth: AuthService;
  client?: any;
}

export function createApp(context: AppContext) {
  const { config } = context;
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });
  app.onError((error, c) => {
    const status = (error as { status?: unknown }).status;
    if (error instanceof HttpError || (typeof status === "number" && status >= 400 && status < 500))
      return c.json({ error: error.message }, status as 400);
    console.error("server.request_failed", { name: error?.name });
    return c.json({ error: "Service unavailable" }, 503);
  });

  const auth = context.auth;
  app.route("/api/web", createApi({ ...context, auth }));
  app.route(
    "/api/assets",
    createAssetRoutes({ config, db: context.db, rooms: context.rooms, assets: context.assets, auth }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

  const authHandler = auth.handler;
  if (authHandler) app.on(["GET", "POST"], "/api/auth/*", (c) => authHandler(c.req.raw));

  const dist = resolve(config.KAN_WEB_DIST);
  const isBackend = (path: string) => path.startsWith("/api") || path.startsWith("/sync");
  if (existsSync(join(dist, "index.html"))) {
    const root = relative(process.cwd(), dist) || ".";
    const assets = serveStatic({ root });
    const index = serveStatic({ root, path: "index.html" });
    app.get("*", (c, next) => (isBackend(c.req.path) ? next() : assets(c, next)));
    app.get("*", (c, next) => (isBackend(c.req.path) ? next() : index(c, next)));
  } else {
    app.get("*", (c, next) =>
      isBackend(c.req.path) ? next() : c.text("Web bundle not built", 503),
    );
  }

  return app;
}
