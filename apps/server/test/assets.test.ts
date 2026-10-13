import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { localAssetStore, createAssetStore } from "../src/assets.ts";
import { fixture, testConfig } from "./helpers.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fake-png-body")]);
const origin = "http://localhost:1430";

async function setup(t: test.TestContext) {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "kan-assets-"));
  const config = testConfig();
  const app = createApp({
    config,
    db: f.db,
    persistence: f.persistence,
    rooms: f.rooms,
    scheduler: { wake() {} },
    assets: localAssetStore(dir),
    auth: {
      async activeAuth(request) {
        const id = request.headers.get("x-test-user") ?? "editor";
        return { user: { id, email: `${id}@example.test`, firstName: null, lastName: null }, sessionId: "s" };
      },
    },
  });
  t.after(async () => {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  const upload = (canvas: string, body: Buffer, type: string, user = "editor") =>
    app.request(`/api/assets?canvas=${canvas}`, {
      method: "POST",
      headers: { origin, "content-type": type, "x-test-user": user },
      body: new Uint8Array(body),
    });
  return { f, app, upload };
}

test("uploaded PNGs are served back with nosniff and registered with the open room", async (t) => {
  const s = await setup(t);
  const handle = await s.f.open();
  const response = await s.upload(s.f.canvas, PNG, "image/png");
  assert.equal(response.status, 200);
  const { src } = await response.json();
  assert.match(src, /^\/api\/assets\?id=[0-9a-f-]{36}$/);
  const id = new URL(src, origin).searchParams.get("id")!;
  assert.ok(handle.assetIds.has(id));
  const read = await s.app.request(src, { headers: { "x-test-user": "viewer" } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("x-content-type-options"), "nosniff");
  assert.equal(read.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), PNG);
});

test("content type, magic bytes, origin, size and membership are enforced", async (t) => {
  const s = await setup(t);
  assert.equal((await s.upload(s.f.canvas, PNG, "image/jpeg")).status, 415);
  assert.equal((await s.upload(s.f.canvas, PNG, "text/plain")).status, 415);
  assert.equal((await s.upload(s.f.canvas, Buffer.alloc(0), "image/png")).status, 400);
  assert.equal((await s.upload(s.f.canvas, Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]), "image/png")).status, 413);
  assert.equal((await s.upload(s.f.canvas, PNG, "image/png", "outsider")).status, 403);
  assert.equal((await s.upload(s.f.canvas, PNG, "image/png", "viewer")).status, 403);
  const badOrigin = await s.app.request(`/api/assets?canvas=${s.f.canvas}`, {
    method: "POST",
    headers: { origin: "https://evil.test", "content-type": "image/png" },
    body: new Uint8Array(PNG),
  });
  assert.equal(badOrigin.status, 403);
  const ok = await s.upload(s.f.canvas, PNG, "image/png");
  const { src } = await ok.json();
  assert.equal((await s.app.request(src, { headers: { "x-test-user": "outsider" } })).status, 403);
  assert.equal((await s.app.request("/api/assets?id=not-a-uuid")).status, 404);
});

test("assets need S3 outside development", () => {
  assert.throws(
    () => createAssetStore(testConfig({ KAN_ENV: "staging", EVE_URL: "https://eve.test", S3_BUCKET: undefined } as any)),
    /S3_BUCKET|Invalid/,
  );
});
