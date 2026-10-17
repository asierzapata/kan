import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteWrapper, SQLiteSyncStorage } from "@tldraw/sync-core";
import { RoomManager } from "../src/rooms.ts";
import { createServer } from "../src/server.ts";
import { schema } from "../src/schema.ts";
import { issueTicket } from "../src/tickets.ts";
import { SECRET, assetRecord, client, connectMessage, fixture, liveIds, testConfig, until } from "./helpers.ts";
import { planTool } from "../src/planner.ts";

async function addNode(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  const run = randomUUID();
  const session = `session-${run}`;
  const thread = randomUUID();
  await f.db.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,'t')", [thread, f.canvas]);
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,session_id,status) VALUES($1,$2,'editor',$3,'h','p',$4,'running')",
    [run, thread, randomUUID(), session],
  );
  return {
    name: "addNode",
    input: { draft: { type: "markdown", title: "Hello", body: "Persisted" } },
    operation: randomUUID(),
    run,
    session,
    user: "editor",
    ...extra,
  } as any;
}
const count = async (f: Awaited<ReturnType<typeof fixture>>, sql: string, args: unknown[] = [f.canvas]) =>
  Number((await f.db.query(sql, args)).rows[0].n);
const records = (f: Awaited<ReturnType<typeof fixture>>) =>
  count(f, "SELECT count(*)::int AS n FROM web_records WHERE room=$1");
const prefix = (canvas: string) => `room_${canvas.replace(/-/g, "_")}_`;

async function humanShape(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = await f.rooms.open(f.canvas);
  const plan = planTool(handle.room, schema, await addNode(f));
  await handle.room.updateStore((store) => plan.puts.forEach((r: any) => store.put(r)));
  return { handle, shape: plan.puts[0] };
}

test("open persists human edits write-behind with a sync event", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const handle = await f.rooms.open(f.canvas);
  assert.equal(handle.revision(), 0);
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_rooms WHERE id=$1"), 1);
  const baseline = await records(f);
  const { shape } = await humanShape(f);
  await until(async () => (await records(f)) > baseline);
  const row = (await f.db.query("SELECT * FROM web_rooms WHERE id=$1", [f.canvas])).rows[0];
  assert.equal(row.revision, handle.storage.getSnapshot().documentClock);
  assert.ok((await f.db.query("SELECT 1 FROM web_records WHERE room=$1 AND id=$2", [f.canvas, shape.id])).rows.length);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_events WHERE room=$1 AND operation LIKE 'sync:%'"), 1);
});

test("a fresh local disk restores snapshot and clock from Postgres", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { handle, shape } = await humanShape(f);
  await until(async () => (await f.db.query("SELECT 1 FROM web_records WHERE room=$1 AND id=$2", [f.canvas, shape.id])).rows.length);
  await until(() => f.rooms.get(f.canvas)?.lastPersisted === handle.revision());
  const before = handle.storage.getSnapshot();
  await f.rooms.closeRoom(f.canvas);
  const sqlite = new DatabaseSync(":memory:");
  const second = new RoomManager({ db: f.db, persistence: f.persistence, sqlite, schema, flushMs: 20, log: { error() {}, warn() {}, info() {} } });
  t.after(() => second.close());
  const restored = await second.open(f.canvas);
  const after = restored.storage.getSnapshot();
  assert.equal(after.documentClock, before.documentClock);
  assert.deepEqual(
    after.documents.map((d) => d.state).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    before.documents.map((d) => d.state).sort((a: any, b: any) => a.id.localeCompare(b.id)),
  );
});

test("reopening with the same local sqlite does not reseed", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { handle, shape } = await humanShape(f);
  await until(() => f.rooms.get(f.canvas)?.lastPersisted === handle.revision());
  const wrapper = new NodeSqliteWrapper(f.sqlite as never, { tablePrefix: prefix(f.canvas) });
  const clock = SQLiteSyncStorage.getDocumentClock(wrapper);
  await f.rooms.closeRoom(f.canvas);
  const row = (await f.db.query("SELECT payload FROM web_records WHERE room=$1 AND id=$2", [f.canvas, shape.id])).rows[0];
  const tampered = { ...row.payload, state: { ...row.payload.state, props: { ...row.payload.state.props, body: "TAMPERED" } } };
  await f.db.query("UPDATE web_records SET payload=$3 WHERE room=$1 AND id=$2", [f.canvas, shape.id, JSON.stringify(tampered)]);
  const reopened = await f.rooms.open(f.canvas);
  assert.notEqual(reopened, handle);
  assert.equal(SQLiteSyncStorage.getDocumentClock(wrapper), clock);
  const state: any = reopened.storage.getSnapshot().documents.find((d) => d.state.id === shape.id)!.state;
  assert.equal(state.props.body, "Persisted");
});

test("applyTool commits idempotently with receipts and conflicting input detection", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const command = await addNode(f);
  await f.rooms.applyTool(f.canvas, command);
  const handle = f.rooms.get(f.canvas)!;
  assert.ok(handle.storage.getSnapshot().documents.some((d) => d.state.id === `shape:${command.operation}`));
  const event = (await f.persistence.replay(f.canvas)).find((e: any) => e.operation === command.operation);
  assert.ok(event.changes.puts.some((d: any) => d.state.id === `shape:${command.operation}`));
  assert.equal(event.revision, handle.revision());
  const again: any = await f.rooms.applyTool(f.canvas, command);
  assert.equal(again.duplicate, true);
  assert.equal(again.committedRevision, event.revision);
  assert.deepEqual(again.shapeIds, [`shape:${command.operation}`]);
  assert.equal(
    handle.storage.getSnapshot().documents.filter((d) => d.state.id === `shape:${command.operation}`).length,
    1,
  );
  await assert.rejects(
    f.rooms.applyTool(f.canvas, { ...command, input: { draft: { type: "markdown", title: "Other", body: "x" } } }),
    /Conflicting operation/,
  );
});

test("applyTool rejects a stale expectedRevision", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.rooms.applyTool(f.canvas, await addNode(f));
  const handle = f.rooms.get(f.canvas)!;
  await assert.rejects(
    f.rooms.applyTool(f.canvas, await addNode(f, { expectedRevision: handle.revision() - 1 })),
    (error: any) => error.status === 409 && /Stale agent revision/.test(error.message),
  );
  await f.rooms.applyTool(f.canvas, await addNode(f, { expectedRevision: handle.revision() }));
});

test("revoked membership blocks agent writes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.rooms.open(f.canvas);
  await f.db.query("DELETE FROM web_memberships WHERE workspace=$1 AND user_id='editor'", [f.workspace]);
  const events = await count(f, "SELECT count(*)::int AS n FROM web_events WHERE room=$1");
  const total = await records(f);
  const command = await addNode(f);
  await assert.rejects(f.rooms.applyTool(f.canvas, command), /Write access revoked/);
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_events WHERE room=$1"), events);
  assert.equal(await records(f), total);
  assert.ok(!f.rooms.get(f.canvas)!.storage.getSnapshot().documents.some((d) => d.state.id === `shape:${command.operation}`));
});

test("a cancelled run cannot write", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await assert.rejects(
    f.rooms.applyTool(f.canvas, await addNode(f, { run: randomUUID(), session: "nope" })),
    /Run cancelled or replaced/,
  );
});

test("authorizeRecord only admits https and owned asset sources over a real socket", async (t) => {
  const f = await fixture();
  const other = randomUUID();
  await f.db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,'Other')", [other, f.workspace]);
  const foreignAsset = randomUUID();
  const ownAsset = randomUUID();
  for (const [asset, canvas] of [[foreignAsset, other], [ownAsset, f.canvas]])
    await f.db.query(
      "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,'editor',$3,'image/png',1)",
      [asset, canvas, `${canvas}/${asset}`],
    );
  const config = testConfig();
  const app = createServer({
    config,
    db: f.db,
    kysely: f.kysely,
    persistence: f.persistence,
    sqlite: f.sqlite,
    flushMs: 20,
    authorize: async (claims) => ({ role: claims.role }),
  });
  t.after(async () => {
    await app.close();
    await f.close();
  });
  const port = await app.listen(0);
  const ticket = issueTicket(SECRET, { room: f.canvas, sub: "editor", sessionId: "s", role: "editor", exp: Date.now() + 30_000 });
  const c = client(`ws://127.0.0.1:${port}/sync?ticket=${ticket}`);
  t.after(() => c.ws.close());
  await c.opened;
  c.send(connectMessage());
  await c.next("connect");
  const push = (clientClock: number, id: string, src: string) =>
    c.send({ type: "push", clientClock, diff: { [`asset:${id}`]: ["put", assetRecord(id, src)] } });
  push(1, "https", "https://example.test/a.png");
  push(2, "own", `/api/assets?id=${ownAsset}`);
  push(3, "foreign", `/api/assets?id=${foreignAsset}`);
  push(4, "bogus", "javascript:alert(1)");
  await until(() => c.messages.filter((m) => m.type === "push_result").length >= 4);
  const ids = (): string[] => app.rooms.get(f.canvas)!.storage.getSnapshot().documents.map((d) => d.state.id as string);
  assert.ok(ids().includes("asset:https"));
  assert.ok(ids().includes("asset:own"));
  assert.ok(!ids().includes("asset:foreign"));
  assert.ok(!ids().includes("asset:bogus"));
});

test("a no-op agent operation still leaves a receipt and later writes succeed", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first: any = await f.rooms.applyTool(f.canvas, await addNode(f));
  const shapeId = `shape:${(await f.persistence.replay(f.canvas)).at(-1).operation}`;
  const noop = {
    name: "focusNodes",
    input: { shapeIds: [shapeId] },
    operation: randomUUID(),
    user: "editor",
  };
  const result: any = await f.rooms.applyTool(f.canvas, noop);
  assert.equal(result.revision, first.revision);
  assert.ok(await f.persistence.receipt(f.canvas, noop.operation, { name: "focusNodes", input: noop.input, actor: { user: "editor", run: undefined, session: undefined } }));
  const duplicate: any = await f.rooms.applyTool(f.canvas, noop);
  assert.equal(duplicate.duplicate, true);
  const later: any = await f.rooms.applyTool(f.canvas, await addNode(f));
  assert.ok(later.revision > first.revision);
  const seqs = (await f.db.query("SELECT seq FROM web_events WHERE room=$1 ORDER BY seq", [f.canvas])).rows.map((r) => Number(r.seq));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test("idle rooms are flushed and evicted by tick", async (t) => {
  const f = await fixture({ idleMs: 50 });
  t.after(() => f.close());
  const { handle, shape } = await humanShape(f);
  await new Promise((r) => setTimeout(r, 100));
  await f.rooms.tick(Date.now() + 1000);
  assert.equal(f.rooms.get(f.canvas), undefined);
  assert.equal(handle.closed, true);
  assert.ok((await f.db.query("SELECT 1 FROM web_records WHERE room=$1 AND id=$2", [f.canvas, shape.id])).rows.length);
});

test("unknown or deleted canvases cannot be opened", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await assert.rejects(f.rooms.open(randomUUID()), (e: any) => e.status === 404);
  await assert.rejects(f.rooms.open("not-a-uuid"), (e: any) => e.status === 404);
  await f.db.query("UPDATE web_canvases SET deleted_at=now() WHERE id=$1", [f.canvas]);
  await assert.rejects(f.rooms.open(f.canvas), /Canvas unavailable/);
});

test("humans cannot push kan-image shapes with unsafe sources", async (t) => {
  const f = await fixture();
  const owned = randomUUID();
  await f.db.query(
    "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,'editor',$3,'image/png',1)",
    [owned, f.canvas, `${f.canvas}/${owned}`],
  );
  const app = createServer({
    config: testConfig(),
    db: f.db,
    kysely: f.kysely,
    persistence: f.persistence,
    sqlite: f.sqlite,
    flushMs: 20,
    authorize: async (claims) => ({ role: claims.role }),
    assets: { put: async () => {}, get: async () => null },
  });
  t.after(async () => {
    await app.close();
    await f.close();
  });
  const port = await app.listen(0);
  const ticket = issueTicket(SECRET, { room: f.canvas, sub: "editor", sessionId: "s", role: "editor", exp: Date.now() + 30_000 });
  const c = client(`ws://127.0.0.1:${port}/sync?ticket=${ticket}`);
  t.after(() => c.ws.close());
  await c.opened;
  c.send(connectMessage());
  await c.next("connect");
  const handle = await app.rooms.open(f.canvas);
  const base: any = planTool(handle.room, schema, {
    name: "addNode",
    input: { draft: { type: "image", title: "Image", src: "https://example.test/a.png", alt: "x" } },
    operation: randomUUID(),
    run: randomUUID(),
    user: "editor",
  }).puts[0];
  const image = (name: string, src: string) => ({
    ...base,
    id: `shape:${name}`,
    props: { ...base.props, src },
  });
  const push = (clock: number, record: any) =>
    c.send({ type: "push", clientClock: clock, diff: { [record.id]: ["put", record] } });
  push(1, image("good", "https://example.test/b.png"));
  push(2, image("owned", `/api/assets?id=${owned}`));
  push(3, image("data", "data:image/png;base64,AAAA"));
  push(4, image("plain", "http://example.test/c.png"));
  await until(() => c.messages.filter((m) => m.type === "push_result").length >= 4);
  const ids = liveIds(app.rooms.get(f.canvas)!);
  assert.ok(ids.includes("shape:good"));
  assert.ok(ids.includes("shape:owned"));
  assert.ok(!ids.includes("shape:data"));
  assert.ok(!ids.includes("shape:plain"));
});

test("agent image drafts are validated before the store changes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const owned = randomUUID();
  const foreign = randomUUID();
  await f.db.query(
    "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,'editor',$3,'image/png',1)",
    [owned, f.canvas, `${f.canvas}/${owned}`],
  );
  const draft = (src: string) => ({ draft: { type: "image", title: "Image", src, alt: "x" } });
  const handle = await f.rooms.open(f.canvas);
  const before = JSON.stringify(handle.storage.getSnapshot());
  const clock = handle.revision();
  await assert.rejects(
    f.rooms.applyTool(f.canvas, await addNode(f, { input: draft(`https://kan.test/api/assets?id=${foreign}`) })),
    (error: any) => error.status === 400 && /another canvas/.test(error.message),
  );
  await assert.rejects(
    f.rooms.applyTool(f.canvas, await addNode(f, { input: draft("http://example.test/a.png") })),
    (error: any) => error.status === 400 && /Invalid image URL/.test(error.message),
  );
  assert.equal(JSON.stringify(handle.storage.getSnapshot()), before);
  assert.equal(handle.revision(), clock);
  const ok: any = await f.rooms.applyTool(f.canvas, await addNode(f, { input: draft(`https://kan.test/api/assets?id=${owned}`) }));
  assert.ok(ok.revision > clock);
});
