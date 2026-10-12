import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import { revertRun, retryRun } from "../../../apps/web/src/lib/runs.ts";
import { Coordinator } from "../../../apps/realtime/src/coordinator.mjs";
import { planTool, planRevert } from "../../../apps/realtime/src/tools.ts";
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
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const persistence = new Persistence(db);
  await persistence.migrate();
  const workspace = randomUUID(),
    canvas = randomUUID(),
    thread = randomUUID();
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,$2)", [workspace, "Synthetic"]);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,$3)", [canvas, workspace, "Fixture"]);
  await db.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,'T')", [thread, canvas]);
  for (const role of ["owner", "editor", "viewer"])
    await db.query(
      "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,$4)",
      [workspace, role, `${role}@example.test`, role],
    );
  const room = await Coordinator.open(persistence, canvas, { schema });
  t.after(() => room.close());
  return { db, persistence, workspace, canvas, thread, room };
}
async function makeRun(f, status = "complete") {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,status,session_id) VALUES($1,$2,'editor',$3,'hash','Synthetic',$4,$5)",
    [id, f.thread, randomUUID(), status, `session-${id}`],
  );
  return id;
}
const agentCommand = (run, callId, name, input) => ({
  name,
  input,
  operation: `${run}:${callId}`,
  run,
  user: "editor",
});
async function apply(f, c) {
  const plan = planTool(f.room.room, schema, c);
  await f.room.transact(
    c.operation,
    { name: c.name, input: c.input },
    (room) =>
      room.updateStore((store) => {
        plan.removes.forEach((id) => store.delete(id));
        plan.puts.forEach((record) => store.put(record));
      }),
    true,
  );
  return plan;
}
const workerStub = (f) => async (body) => {
  assert.equal(body.name, "revertRun");
  const plan = planRevert(f.room.room, body.input.candidates);
  if (plan.removes.length)
    await f.room.transact(
      body.operation,
      { name: body.name, input: body.input, actor: { user: body.user } },
      (room) =>
        room.updateStore((store) => plan.removes.forEach((id) => store.delete(id))),
      true,
    );
  return { ...plan.result, revision: f.room.revision };
}
const revert = (f, run, user = "editor") =>
  revertRun(f.db, f.canvas, user, run, workerStub(f));
const sorted = (list) => [...list].sort();
const liveIds = (f) =>
  f.room.room.getCurrentSnapshot().documents.map((doc) => doc.state.id);

test("revert removes unchanged created records and keeps later human edits", async (t) => {
  const f = await fixture(t),
    run = await makeRun(f);
  const a = (
    await apply(f, agentCommand(run, "a", "addNode", { draft: { type: "markdown", title: "A", body: "agent" } }))
  ).puts[0].id;
  const b = (
    await apply(f, agentCommand(run, "b", "addNode", { draft: { type: "markdown", title: "B", body: "agent" } }))
  ).puts[0].id;
  const link = await apply(f, agentCommand(run, "c", "connectNodes", { from: a, to: b, label: "Link" }));
  const arrowAndBindings = link.puts.map((record) => record.id);
  assert.equal(arrowAndBindings.length, 3);
  await f.room.transact(
    randomUUID(),
    { frame: "human edit" },
    (room) =>
      room.updateStore((store) => {
        const record = store.get(a);
        store.put({ ...record, props: { ...record.props, body: "human" } });
      }),
    true,
  );
  const before = f.room.revision;
  const result = await revert(f, run);
  assert.deepEqual(sorted(result.removed), sorted([b, ...arrowAndBindings]));
  assert.deepEqual(result.kept, [a]);
  assert.deepEqual(result.skippedUpdates, []);
  assert.equal(f.room.revision, before + 1);
  const live = f.room.room.getCurrentSnapshot().documents.map((doc) => doc.state);
  assert.equal(live.find((record) => record.id === a).props.body, "human");
  assert.equal(live.some((record) => record.id === b), false);
  assert.equal(live.some((record) => record.typeName === "binding"), false);
});

test("revert of a turn that only updated a human node removes nothing", async (t) => {
  const f = await fixture(t),
    run = await makeRun(f);
  const human = (
    await apply(f, {
      name: "addNode",
      input: { draft: { type: "markdown", title: "Human", body: "mine" } },
      operation: randomUUID(),
      run: randomUUID(),
      user: "editor",
    })
  ).puts[0].id;
  await apply(f, agentCommand(run, "u", "updateNode", { shapeId: human, patch: { type: "markdown", body: "edited by agent" } }));
  const before = f.room.revision;
  const result = await revert(f, run);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedUpdates, [human]);
  assert.equal(f.room.revision, before);
  assert.ok(liveIds(f).includes(human));
  const row = (await f.db.query("SELECT reverted_at FROM web_runs WHERE id=$1", [run])).rows[0];
  assert.ok(row.reverted_at);
});

test("a run can be reverted only once", async (t) => {
  const f = await fixture(t),
    run = await makeRun(f);
  await apply(f, agentCommand(run, "a", "addNode", { draft: { type: "markdown", title: "A", body: "x" } }));
  await revert(f, run);
  await assert.rejects(revert(f, run), (error) => error.status === 409);
});

test("running turns and viewers cannot revert", async (t) => {
  const f = await fixture(t),
    running = await makeRun(f, "running"),
    done = await makeRun(f);
  await assert.rejects(revert(f, running), (error) => error.status === 409 && /finished/.test(error.message));
  await assert.rejects(revert(f, done, "viewer"), (error) => error.status === 403);
  assert.equal(
    (await f.db.query("SELECT reverted_at FROM web_runs WHERE id=$1", [done])).rows[0].reverted_at,
    null,
  );
});

test("revert leaves the original receipts so retry still refuses to replay", async (t) => {
  const f = await fixture(t),
    run = await makeRun(f, "failed");
  await apply(f, agentCommand(run, "a", "addNode", { draft: { type: "markdown", title: "A", body: "x" } }));
  const result = await revert(f, run);
  assert.equal(result.removed.length, 1);
  const receipts = (
    await f.db.query("SELECT operation FROM web_events WHERE room=$1 AND operation LIKE $2", [f.canvas, `${run}:%`])
  ).rows;
  assert.equal(receipts.length, 1);
  const client = { sessions: { attach() { return { async reset() { throw Error("Must not reset"); } }; } } };
  await assert.rejects(
    f.db.transaction((tx) => retryRun(tx, f.canvas, "editor", run, "auth", client)),
    /saved changes/,
  );
});

test("a stale agent revision is rejected without changing the canvas and succeeds after re-reading", async (t) => {
  const f = await fixture(t),
    run = await makeRun(f, "running");
  const guarded = async (c, expectedRevision) => {
    if (expectedRevision !== f.room.revision)
      throw Error("Stale agent revision; read canvas again");
    const plan = planTool(f.room.room, schema, c);
    await f.room.transact(
      c.operation,
      { name: c.name, input: c.input },
      (room) => {
        if (expectedRevision !== f.room.revision) throw Error("Stale agent revision");
        return room.updateStore((store) => plan.puts.forEach((record) => store.put(record)));
      },
      true,
    );
    return plan;
  };
  const seen = f.room.revision;
  await apply(f, { name: "addNode", input: { draft: { type: "markdown", title: "Human", body: "h" } }, operation: randomUUID(), run: randomUUID(), user: "editor" });
  const after = f.room.revision;
  assert.equal(after, seen + 1);
  const snapshotBefore = JSON.stringify(f.room.room.getCurrentSnapshot().documents);
  const add = agentCommand(run, "stale", "addNode", { draft: { type: "markdown", title: "Agent", body: "a" } });
  await assert.rejects(guarded(add, seen), /Stale agent revision/);
  assert.equal(JSON.stringify(f.room.room.getCurrentSnapshot().documents), snapshotBefore);
  assert.equal(f.room.revision, after);
  await guarded(add, f.room.revision);
  assert.equal(f.room.revision, after + 1);
});
