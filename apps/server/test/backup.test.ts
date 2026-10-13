import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hash } from "@kan/web-core/hash";
import { exportCanvas, importCanvas } from "@kan/web-core/backup";
import { memoryDatabase } from "../src/database.ts";
import { enqueue } from "../src/runs.ts";
import { startMeeting, ingestSegments } from "../src/meeting.ts";
import { agentCommand, command, manager, seedWorkspace, apply, type Fixture } from "./helpers.ts";

const tables = [
  "web_workspaces", "web_memberships", "web_canvases", "web_rooms", "web_records",
  "web_events", "web_threads", "web_runs", "web_messages", "web_assets",
  "web_meeting_sessions", "web_transcript_segments",
];
async function database(t: test.TestContext, workspace: string) {
  const database = await memoryDatabase();
  const { db, persistence } = database;
  await seedWorkspace(db, workspace);
  const { rooms, sqlite } = manager(db, persistence);
  t.after(async () => {
    await rooms.close();
    sqlite.close();
    await database.close();
  });
  return { db, persistence, rooms };
}
async function source(t: test.TestContext) {
  const workspace = randomUUID(),
    canvas = randomUUID();
  const { db, persistence, rooms } = await database(t, workspace);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,'Fixture')", [canvas, workspace]);
  const thread = randomUUID();
  await db.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,'Ops')", [thread, canvas]);
  const f = { db, persistence, rooms, canvas, workspace, thread, open: () => rooms.open(canvas) } as unknown as Fixture;
  const a = (await apply(f, command("addNode", { draft: { type: "markdown", title: "A", body: "one" } }))).puts[0].id;
  const b = (await apply(f, command("addNode", { draft: { type: "markdown", title: "B", body: "two" } }))).puts[0].id;
  await apply(f, command("connectNodes", { from: a, to: b, label: "Link" }));
  const request = await db.transaction((tx) =>
    enqueue(tx, canvas, "editor", { operation: randomUUID(), message: "Backup request" }),
  );
  await db.query("UPDATE web_runs SET status='complete',reverted_at=now() WHERE id=$1", [request.id]);
  await db.query(
    "INSERT INTO web_messages(id,thread,run,role,content,evidence) VALUES('reply-1',$1,$2,'assistant','Done','[]')",
    [request.thread, request.id],
  );
  const meeting = await db.transaction((tx) => startMeeting(tx, canvas, "editor", { label: "Backup meeting" }));
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
  await db.query("UPDATE web_meeting_sessions SET processed_cursor=3,pending_cursor=3,context_runs=1 WHERE id=$1", [meeting.id]);
  await db.query(
    "INSERT INTO web_assets(id,canvas,user_id,object_key,content_type,size) VALUES($1,$2,'editor',$3,'image/png',10)",
    [randomUUID(), canvas, `key-${randomUUID()}`],
  );
  return { workspace, canvas, db, persistence, rooms, f };
}
const counts = async (db: any) =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [table, (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n]),
    ),
  );
const documents = (handle: any) =>
  handle.room
    .getCurrentSnapshot()
    .documents.map((doc: any) => [doc.state.id, hash(doc)])
    .sort(([x]: any, [y]: any) => (x < y ? -1 : 1));

test("export then import restores every row and a live, writable room", async (t) => {
  const s = await source(t);
  const snapshot = await exportCanvas(s.db, s.canvas);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.transcriptSegments.length, 3);
  const targetWorkspace = randomUUID();
  const target = await database(t, targetWorkspace);
  const inserted = await importCanvas(target.db, snapshot, { workspace: targetWorkspace });
  assert.equal(inserted.web_events, 3);
  const before = await counts(s.db);
  const after = await counts(target.db);
  for (const table of tables.filter((name) => !name.startsWith("web_work") && name !== "web_memberships"))
    assert.equal(after[table], before[table], table);
  const original = await s.rooms.open(s.canvas);
  const restored = await target.rooms.open(s.canvas);
  assert.equal(restored.revision(), original.revision());
  assert.deepEqual(documents(restored), documents(original));
  const run = (await target.db.query("SELECT reverted_at,status FROM web_runs WHERE prompt='Backup request'")).rows[0];
  assert.ok(run.reverted_at);
  const session = (await target.db.query("SELECT * FROM web_meeting_sessions")).rows[0];
  assert.equal(session.processed_cursor, 3);
  assert.equal(session.context_runs, 1);
  const revision = restored.revision();
  const run2 = randomUUID();
  await target.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,status,session_id) VALUES($1,$2,'editor',$3,'h','p','running',$4)",
    [run2, (await target.db.query("SELECT id FROM web_threads WHERE title='Ops'")).rows[0].id, randomUUID(), `session-${run2}`],
  );
  await target.rooms.applyTool(
    s.canvas,
    agentCommand(run2, "after", "addNode", { draft: { type: "markdown", title: "After restore", body: "live" } }),
  );
  assert.equal(restored.revision(), revision + 1);
  assert.equal((await counts(target.db)).web_events, 4);
  await assert.rejects(
    importCanvas(target.db, snapshot, { workspace: targetWorkspace }),
    (error: any) => error.status === 409 && /already exists/.test(error.message),
  );
});

test("a JSON-serialized backup round-trips without Date or type drift", async (t) => {
  const s = await source(t);
  const wire = JSON.parse(JSON.stringify(await exportCanvas(s.db, s.canvas)));
  const targetWorkspace = randomUUID();
  const target = await database(t, targetWorkspace);
  await importCanvas(target.db, wire, { workspace: targetWorkspace });
  const again: any = await exportCanvas(target.db, s.canvas);
  const original: any = await exportCanvas(s.db, s.canvas);
  for (const key of ["room", "records", "events", "threads", "runs", "messages", "assets", "meetingSessions", "transcriptSegments"])
    assert.deepEqual(again[key], original[key], key);
  assert.equal(typeof wire.canvas.created_at, "string");
});
