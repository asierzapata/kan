import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import { hash } from "../src/hash.mjs";
import { exportCanvas, importCanvas } from "../src/backup.mjs";
import { enqueue } from "../../../apps/web/src/lib/runs.ts";
import { startMeeting, ingestSegments } from "../../../apps/web/src/lib/meeting.ts";
import { Coordinator } from "../../../apps/realtime/src/coordinator.mjs";
import { planTool } from "../../../apps/realtime/src/tools.ts";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import * as props from "../../../apps/desktop/src/nodes/shapes/types.ts";

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    ...Object.fromEntries(
      ["markdown", "chart", "table", "image", "map", "logo", "timeline", "calendar"].map(
        (type) => [`kan-${type}`, { props: props[`${type}ShapeProps`] }],
      ),
    ),
  },
});
const tables = [
  "web_workspaces", "web_memberships", "web_canvases", "web_rooms", "web_records",
  "web_events", "web_threads", "web_runs", "web_messages", "web_assets",
  "web_meeting_sessions", "web_transcript_segments",
];
async function database(t, workspace) {
  const db = new PGlite();
  t.after(() => db.close());
  const persistence = new Persistence(db);
  await persistence.migrate();
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,'Synthetic')", [workspace]);
  for (const role of ["owner", "editor", "viewer"])
    await db.query(
      "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,$4)",
      [workspace, role, `${role}@example.test`, role],
    );
  return { db, persistence };
}
async function apply(coordinator, name, input) {
  const command = { name, input, operation: randomUUID(), run: randomUUID(), user: "editor" };
  const plan = planTool(coordinator.room, schema, command);
  await coordinator.transact(
    command.operation,
    { name, input },
    (room) =>
      room.updateStore((store) => {
        plan.removes.forEach((id) => store.delete(id));
        plan.puts.forEach((record) => store.put(record));
      }),
    true,
  );
  return plan;
}
async function source(t) {
  const workspace = randomUUID(),
    canvas = randomUUID();
  const { db, persistence } = await database(t, workspace);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,'Fixture')", [canvas, workspace]);
  const room = await Coordinator.open(persistence, canvas, { schema });
  t.after(() => room.close());
  const a = (await apply(room, "addNode", { draft: { type: "markdown", title: "A", body: "one" } })).puts[0].id;
  const b = (await apply(room, "addNode", { draft: { type: "markdown", title: "B", body: "two" } })).puts[0].id;
  await apply(room, "connectNodes", { from: a, to: b, label: "Link" });
  const request = await db.transaction((tx) =>
    enqueue(tx, canvas, "editor", { operation: randomUUID(), message: "Backup request" }),
  );
  await db.query("UPDATE web_runs SET status='complete',reverted_at=now() WHERE id=$1", [request.id]);
  await db.query(
    "INSERT INTO web_messages(id,thread,run,role,content,evidence) VALUES('reply-1',$1,$2,'assistant','Done','[]')",
    [request.thread, request.id],
  );
  const meeting = await db.transaction((tx) =>
    startMeeting(tx, canvas, "editor", { label: "Backup meeting" }),
  );
  await db.transaction((tx) =>
    ingestSegments(tx, canvas, "editor", {
      session: meeting.id,
      segments: [1, 2, 3].map((i) => ({
        sourceId: `s${i}`, speaker: "Ana", text: `Segment ${i}`, startedAtMs: i * 1000, final: true,
      })),
    }),
  );
  const contextRun = randomUUID();
  await db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,status,kind,meeting_session,context_from,context_to) VALUES($1,$2,'editor',$3,'hash','Context','complete','context',$4,1,3)",
    [contextRun, meeting.thread, randomUUID(), meeting.id],
  );
  await db.query(
    "INSERT INTO web_messages(id,thread,run,role,content,evidence) VALUES($1,$2,$3,'context','Meeting context 1–3',$4)",
    [contextRun, meeting.thread, contextRun, JSON.stringify([{ session: meeting.id, from: 1, to: 3 }])],
  );
  await db.query(
    "UPDATE web_meeting_sessions SET processed_cursor=3,pending_cursor=3,context_runs=1 WHERE id=$1",
    [meeting.id],
  );
  await db.query(
    "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,'editor',$3,'image/png',10)",
    [randomUUID(), canvas, `key-${randomUUID()}`],
  );
  return { workspace, canvas, db, persistence, room };
}
const counts = async (db) =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
      ]),
    ),
  );
const documents = (coordinator) =>
  coordinator.room
    .getCurrentSnapshot()
    .documents.map((doc) => [doc.state.id, hash(doc)])
    .sort(([x], [y]) => (x < y ? -1 : 1));

test("export then import restores every row and a live, writable room", async (t) => {
  const f = await source(t);
  const snapshot = await exportCanvas(f.db, f.canvas);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.transcriptSegments.length, 3);
  const targetWorkspace = randomUUID();
  const target = await database(t, targetWorkspace);
  const inserted = await importCanvas(target.db, snapshot, { workspace: targetWorkspace });
  assert.equal(inserted.web_events, 3);
  const before = await counts(f.db);
  const after = await counts(target.db);
  for (const table of tables.filter((name) => !name.startsWith("web_work") && name !== "web_memberships"))
    assert.equal(after[table], before[table], table);
  const restored = await Coordinator.open(target.persistence, f.canvas, { schema });
  t.after(() => restored.close());
  assert.equal(restored.revision, f.room.revision);
  assert.deepEqual(documents(restored), documents(f.room));
  const run = (await target.db.query("SELECT reverted_at,status FROM web_runs WHERE kind='request'")).rows[0];
  assert.ok(run.reverted_at);
  const session = (await target.db.query("SELECT * FROM web_meeting_sessions")).rows[0];
  assert.equal(session.processed_cursor, 3);
  assert.equal(session.context_runs, 1);
  const revision = restored.revision;
  await apply(restored, "addNode", { draft: { type: "markdown", title: "After restore", body: "live" } });
  assert.equal(restored.revision, revision + 1);
  assert.equal((await counts(target.db)).web_events, 4);
  await assert.rejects(
    importCanvas(target.db, snapshot, { workspace: targetWorkspace }),
    (error) => error.status === 409 && /already exists/.test(error.message),
  );
});

test("a JSON-serialized backup round-trips without Date or type drift", async (t) => {
  const f = await source(t);
  const wire = JSON.parse(JSON.stringify(await exportCanvas(f.db, f.canvas)));
  const targetWorkspace = randomUUID();
  const target = await database(t, targetWorkspace);
  await importCanvas(target.db, wire, { workspace: targetWorkspace });
  const again = await exportCanvas(target.db, f.canvas);
  const original = await exportCanvas(f.db, f.canvas);
  for (const key of ["room", "records", "events", "threads", "runs", "messages", "assets", "meetingSessions", "transcriptSegments"])
    assert.deepEqual(again[key], original[key], key);
  assert.equal(typeof wire.canvas.created_at, "string");
});
