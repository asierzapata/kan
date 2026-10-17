import test from "node:test";
import assert from "node:assert/strict";
import { revertRun, retryRun } from "../src/runs.ts";
import { apply, agentCommand, command, fixture, liveIds, makeRun, type Fixture } from "./helpers.ts";

const revert = async (f: Fixture, run: string, user = "editor") => {
  if (finals.has(run)) await f.db.query("UPDATE web_runs SET status=$2 WHERE id=$1", [run, finals.get(run)]);
  return revertRun(f.db, f.canvas, user, run, (c) => f.rooms.applyTool(f.canvas, c));
};
const finals = new Map<string, string>();
const started = async (f: Fixture, final = "complete") => {
  const run = await makeRun(f, "running");
  finals.set(run, final);
  return run;
};
const sorted = (list: string[]) => [...list].sort();
const md = (title: string, body: string) => ({ draft: { type: "markdown", title, body } });

test("revert removes unchanged created records and keeps later human edits", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await started(f);
  const a = (await apply(f, agentCommand(run, "a", "addNode", md("A", "agent")))).puts[0].id;
  const b = (await apply(f, agentCommand(run, "b", "addNode", md("B", "agent")))).puts[0].id;
  const link = await apply(f, agentCommand(run, "c", "connectNodes", { from: a, to: b, label: "Link" }));
  const arrowAndBindings = link.puts.map((record: any) => record.id);
  assert.equal(arrowAndBindings.length, 3);
  const handle = await f.open();
  await handle.room.updateStore((store) => {
    const record: any = store.get(a);
    store.put({ ...record, props: { ...record.props, body: "human" } });
  });
  const before = handle.revision();
  const result = await revert(f, run);
  assert.deepEqual(sorted(result.removed), sorted([b, ...arrowAndBindings]));
  assert.deepEqual(result.kept, [a]);
  assert.deepEqual(result.skippedUpdates, []);
  assert.equal(handle.revision(), before + 1);
  const live = handle.room.getCurrentSnapshot().documents.map((doc) => doc.state as any);
  assert.equal(live.find((record) => record.id === a).props.body, "human");
  assert.equal(live.some((record) => record.id === b), false);
  assert.equal(live.some((record) => record.typeName === "binding"), false);
});

test("revert of a turn that only updated a human node removes nothing", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await started(f);
  const human = (await apply(f, command("addNode", md("Human", "mine")))).puts[0].id;
  await apply(f, agentCommand(run, "u", "updateNode", { shapeId: human, patch: { type: "markdown", body: "edited by agent" } }));
  const handle = await f.open();
  const before = handle.revision();
  const result = await revert(f, run);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedUpdates, [human]);
  assert.equal(handle.revision(), before);
  assert.ok(liveIds(handle).includes(human));
  const row = (await f.db.query("SELECT reverted_at FROM web_runs WHERE id=$1", [run])).rows[0];
  assert.ok(row.reverted_at);
});

test("a run can be reverted only once", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await started(f);
  await apply(f, agentCommand(run, "a", "addNode", md("A", "x")));
  await revert(f, run);
  await assert.rejects(revert(f, run), (error: any) => error.status === 409);
});

test("running turns and viewers cannot revert", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const running = await makeRun(f, "running"),
    done = await started(f);
  await assert.rejects(revert(f, running), (error: any) => error.status === 409 && /finished/.test(error.message));
  await assert.rejects(revert(f, done, "viewer"), (error: any) => error.status === 403);
  assert.equal((await f.db.query("SELECT reverted_at FROM web_runs WHERE id=$1", [done])).rows[0].reverted_at, null);
});

test("revert leaves the original receipts so retry still refuses to replay", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await started(f, "failed");
  await apply(f, agentCommand(run, "a", "addNode", md("A", "x")));
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
  const f = await fixture();
  t.after(() => f.close());
  const run = await makeRun(f, "running");
  const handle = await f.open();
  const seen = handle.revision();
  await apply(f, command("addNode", md("Human", "h")));
  const after = handle.revision();
  assert.equal(after, seen + 1);
  const snapshotBefore = JSON.stringify(handle.room.getCurrentSnapshot().documents);
  const add = agentCommand(run, "stale", "addNode", md("Agent", "a"));
  await assert.rejects(
    f.rooms.applyTool(f.canvas, { ...add, expectedRevision: seen }),
    (error: any) => error.status === 409 && /Stale agent revision/.test(error.message),
  );
  assert.equal(JSON.stringify(handle.room.getCurrentSnapshot().documents), snapshotBefore);
  assert.equal(handle.revision(), after);
  await f.rooms.applyTool(f.canvas, { ...add, expectedRevision: handle.revision() });
  assert.equal(handle.revision(), after + 1);
});
