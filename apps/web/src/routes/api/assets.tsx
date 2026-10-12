import { createFileRoute } from "@tanstack/react-router";
import { activeAuth } from "../../lib/session";
import { randomUUID } from "node:crypto";
import { database } from "../../lib/database";
import { canvasAccess, HttpError } from "../../lib/access";
export const Route = createFileRoute("/api/assets")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
async function handle(request: Request): Promise<Response> {
  try {
    const { user } = await activeAuth();
    if (!user) throw new HttpError(401, "Sign in required");
    const { db } = await database(),
      url = new URL(request.url);
    if (request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        throw new HttpError(403, "Invalid origin");
      const canvas = url.searchParams.get("canvas");
      await db.transaction((tx: any) =>
        canvasAccess(tx, canvas!, user.id, "editor"),
      );
      const contentType = request.headers.get("content-type") || "";
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          contentType,
        )
      )
        throw new HttpError(415, "Upload PNG, JPEG, WebP or GIF");
      if (Number(request.headers.get("content-length")) > 4 * 1024 * 1024)
        throw new HttpError(413, "Maximum upload is 4 MiB");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "File required");
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(413, "Maximum upload is 4 MiB");
        }
        parts.push(next.value);
      }
      if (!size) throw new HttpError(400, "File required");
      const bytes = Buffer.concat(parts);
      const valid =
        contentType === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : contentType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216
            : contentType === "image/gif"
              ? bytes.subarray(0, 6).toString().startsWith("GIF8")
              : bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new HttpError(415, "File does not match image type");
      const id = randomUUID(),
        key = `${canvas}/${id}`;
      const response = await fetch(
        `${process.env.STAGING_WORKER_URL}/asset?key=${encodeURIComponent(key)}`,
        {
          method: "PUT",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${process.env.STAGING_SECRET}`,
            "content-type": contentType,
          },
          body: bytes,
        },
      );
      if (!response.ok) throw new HttpError(503, "Storage unavailable");
      await db.transaction(async (tx: any) => {
        await canvasAccess(tx, canvas!, user.id, "editor");
        await tx.query(
          "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,$3,$4,$5,$6)",
          [id, canvas, user.id, key, contentType, size],
        );
      });
      return Response.json(
        { src: `${url.origin}/api/assets?id=${id}` },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const asset = (
      await db.query("SELECT * FROM web_assets WHERE id=$1", [
        url.searchParams.get("id"),
      ])
    ).rows[0];
    if (!asset) throw new HttpError(404, "Asset unavailable");
    await db.transaction((tx: any) => canvasAccess(tx, asset.canvas, user.id));
    const response = await fetch(
      `${process.env.STAGING_WORKER_URL}/asset?key=${encodeURIComponent(asset.object_key)}`,
      {
        redirect: "manual",
        headers: { authorization: `Bearer ${process.env.STAGING_SECRET}` },
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": asset.content_type,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof HttpError ? error.message : "Asset unavailable",
      },
      { status: error instanceof HttpError ? error.status : 503 },
    );
  }
}
