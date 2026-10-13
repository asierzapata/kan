import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { canvasAccess, HttpError } from "./http.ts";
import type { RoomManager } from "./rooms.ts";
import type { AssetStore } from "./assets.ts";

const MAX = 4 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface AssetRouteContext {
  config: Config;
  db: Database;
  rooms: RoomManager;
  assets: AssetStore;
  auth: { activeAuth(request: Request): Promise<Auth> };
}

export function createAssetRoutes({ config, db, rooms, assets, auth }: AssetRouteContext) {
  const app = new Hono();
  app.all("/", async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    if (request.method === "POST") {
      const { user } = await auth.activeAuth(request);
      if (request.headers.get("origin") !== config.KAN_PUBLIC_URL)
        throw new HttpError(403, "Invalid origin");
      const canvas = url.searchParams.get("canvas");
      await db.transaction((tx) => canvasAccess(tx, canvas!, user.id, "editor"));
      const contentType = request.headers.get("content-type") || "";
      if (!TYPES.includes(contentType)) throw new HttpError(415, "Upload PNG, JPEG, WebP or GIF");
      if (Number(request.headers.get("content-length")) > MAX)
        throw new HttpError(413, "Maximum upload is 4 MiB");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "File required");
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX) {
          await reader.cancel();
          throw new HttpError(413, "Maximum upload is 4 MiB");
        }
        parts.push(next.value);
      }
      if (!size) throw new HttpError(400, "File required");
      const bytes = Buffer.concat(parts);
      const valid =
        contentType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : contentType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216
            : contentType === "image/gif"
              ? bytes.subarray(0, 6).toString().startsWith("GIF8")
              : bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new HttpError(415, "File does not match image type");
      const id = randomUUID(),
        key = `${canvas}/${id}`;
      try {
        await assets.put(key, bytes, contentType);
      } catch {
        throw new HttpError(503, "Storage unavailable");
      }
      await db.transaction(async (tx) => {
        await canvasAccess(tx, canvas!, user.id, "editor");
        await tx.query(
          "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,$3,$4,$5,$6)",
          [id, canvas, user.id, key, contentType, size],
        );
      });
      rooms.registerAsset(canvas!, id);
      return c.json({ src: `/api/assets?id=${id}` }, 200, { "cache-control": "no-store" });
    }
    if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    const { user } = await auth.activeAuth(request);
    const id = url.searchParams.get("id") ?? "";
    const asset = /^[0-9a-f-]{36}$/.test(id)
      ? (await db.query("SELECT * FROM web_assets WHERE id=$1", [id])).rows[0]
      : undefined;
    if (!asset) throw new HttpError(404, "Asset unavailable");
    await db.transaction((tx) => canvasAccess(tx, asset.canvas, user.id));
    const object = await assets.get(asset.object_key);
    if (!object) throw new HttpError(404, "Asset unavailable");
    return new Response(object.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": asset.content_type,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  return app;
}
