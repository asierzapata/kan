import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canvasAccess, workspaceAccess } from "../src/http.ts";
import { enqueue, dispatch, retryRun } from "../src/runs.ts";
import { parseDiagram } from "../src/diagrams.ts";
import { RunStreamBoundary } from "../src/run-stream.ts";
import { planTool } from "../src/planner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { schema } from "../src/schema.ts";
import { apply, command, fixture, liveIds, manager, shapes, until } from "./helpers.ts";

const count = async (f: any, sql: string, args: unknown[] = [f.canvas]) =>
  Number((await f.db.query(sql, args)).rows[0].n);
const events = (f: any) => count(f, "SELECT count(*)::int AS n FROM web_events WHERE room=$1");
const flushed = (handle: any) => until(() => handle.lastPersisted === handle.revision());

test("workspace roles, denied writes, cross-workspace access and revocation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await canvasAccess(f.db, f.canvas, "viewer")).role, "viewer");
  await assert.rejects(canvasAccess(f.db, f.canvas, "viewer", "editor"), /denied/);
  await assert.rejects(workspaceAccess(f.db, f.workspace, "outsider"), /denied/);
  await assert.rejects(workspaceAccess(f.db, f.workspace, "editor", "owner"), /denied/);
  await f.db.query("DELETE FROM web_memberships WHERE workspace=$1 AND user_id=$2", [f.workspace, "editor"]);
  await assert.rejects(canvasAccess(f.db, f.canvas, "editor"), /denied/);
});

test("record-only events, recovery, duplicate receipt and conflicting operation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = command("addNode", { draft: { type: "markdown", title: "Hello", body: "Persisted" } });
  const plan = await apply(f, c);
  const event = (await f.persistence.replay(f.canvas))[0];
  assert.equal(event.changes.puts.length, 1);
  assert.equal("snapshot" in event, false);
  assert.equal(event.changes.puts[0].state.props.body, "Persisted");
  const handle = await f.open();
  const revision = handle.revision();
  const duplicate: any = await f.rooms.applyTool(f.canvas, { ...c, session: `session-${c.run}` });
  assert.equal(duplicate.duplicate, true);
  assert.equal(handle.revision(), revision);
  await assert.rejects(f.persistence.receipt(f.canvas, c.operation, { different: true }), /Conflicting/);
  const before = handle.storage.getSnapshot().documents.map((d) => d.state);
  await f.rooms.closeRoom(f.canvas);
  const second = manager(f.db, f.persistence);
  t.after(() => second.rooms.close());
  const recovered = await second.rooms.open(f.canvas);
  assert.deepEqual(
    recovered.storage.getSnapshot().documents.map((d) => d.state),
    before,
  );
  assert.equal(plan.puts[0].meta.provenance.byUserId, "editor");
});

test("write-behind flush persists exactly the changed documents and removals", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const handle = await f.open();
  const a = planTool(handle.room, schema, command("addNode", { draft: { type: "markdown", title: "A", body: "one" } })).puts[0];
  const b = planTool(handle.room, schema, command("addNode", { draft: { type: "markdown", title: "B", body: "two" } })).puts[0];
  await handle.room.updateStore((store) => {
    store.put(a);
    store.put(b);
  });
  await flushed(handle);
  await handle.room.updateStore((store) => {
    store.put({ ...a, props: { ...a.props, body: "changed" } });
    store.delete(b.id);
  });
  await flushed(handle);
  const last = (await f.db.query("SELECT changes FROM web_events WHERE room=$1 ORDER BY seq DESC LIMIT 1", [f.canvas])).rows[0].changes;
  assert.deepEqual(last.puts.map((d: any) => d.state.id), [a.id]);
  assert.deepEqual(last.removes, [b.id]);
  assert.equal(last.puts[0].state.props.body, "changed");
  const stored = (await f.db.query("SELECT id FROM web_records WHERE room=$1", [f.canvas])).rows.map((r) => r.id);
  assert.ok(stored.includes(a.id));
  assert.ok(!stored.includes(b.id));
  assert.equal("documents" in last.metadata, false);
});

test("a failed flush retries and later succeeds without losing edits", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const handle = await f.open();
  const original: any = f.persistence.persist.bind(f.persistence);
  let failures = 0;
  f.persistence.persist = async (...args: any[]) => {
    if (failures++ < 1) throw new Error("Synthetic database outage");
    return original(...args);
  };
  const a = planTool(handle.room, schema, command("addNode", { draft: { type: "markdown", title: "A", body: "one" } })).puts[0];
  await handle.room.updateStore((store) => store.put(a));
  await until(() => failures >= 1);
  assert.equal(handle.lastPersisted < handle.revision(), true);
  const b = planTool(handle.room, schema, command("addNode", { draft: { type: "markdown", title: "B", body: "two" } })).puts[0];
  await handle.room.updateStore((store) => store.put(b));
  await until(() => handle.lastPersisted === handle.revision(), 5000);
  const stored = (await f.db.query("SELECT id FROM web_records WHERE room=$1", [f.canvas])).rows.map((r) => r.id);
  assert.ok(stored.includes(a.id) && stored.includes(b.id));
});

test("record limits roll back document and event atomically for agent batches only", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.open();
  const removes = Array.from({ length: 501 }, (_, i) => `shape:${i}`);
  await assert.rejects(
    f.persistence.persist(f.canvas, {
      revision: 1,
      metadata: {},
      puts: [],
      removes,
      operation: "oversized",
      input: { actor: { user: "editor" } },
    }),
    /bounded/,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
  assert.equal((await f.db.query("SELECT revision FROM web_rooms WHERE id=$1", [f.canvas])).rows[0].revision, 0);
  await f.persistence.persist(f.canvas, {
    revision: 1, metadata: {}, puts: [], removes, operation: "sync:1", input: null,
  });
  assert.equal((await f.persistence.replay(f.canvas)).length, 1);
});

test("rich-node types and interactive calendar state survive record recovery", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const drafts: any[] = [
    { type: "chart", title: "Chart", spec: { kind: "bar", x: "x", series: [{ key: "y" }] }, data: [{ x: "A", y: 2 }] },
    { type: "table", title: "Table", columns: ["A"], rows: [[1]] },
    { type: "map", title: "Map", markers: [{ lat: 1, lng: 2, label: "Test" }] },
    { type: "logo", domain: "example.com" },
    { type: "timeline", title: "Timeline", events: [{ id: "a", title: "Event", start: "2026-10-12" }] },
    { type: "calendar", title: "Calendar", events: [] },
    { type: "image", title: "Image", src: "https://example.com/image.png", alt: "Test" },
    { type: "geo", geo: "ellipse" },
  ];
  let calendar = "";
  for (const draft of drafts) {
    const plan = await apply(f, command("addNode", { draft }));
    if (draft.type === "calendar") calendar = plan.puts[0].id;
  }
  await apply(f, command("updateNode", { shapeId: calendar, patch: { type: "calendar", selectedDate: "2027-01-12" } }));
  await f.rooms.closeRoom(f.canvas);
  const second = manager(f.db, f.persistence);
  t.after(() => second.rooms.close());
  const restored = await second.rooms.open(f.canvas);
  const list = shapes(restored);
  assert.equal(list.length, 8);
  assert.equal(list.find((s) => s.id === calendar).props.month, "2027-01");
});

test("connect, arrange, group and remove maintain record graph", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = (await apply(f, command("addNode", { draft: { type: "geo", geo: "rectangle" } }))).puts[0].id,
    b = (await apply(f, command("addNode", { draft: { type: "markdown", title: "B", body: "Body" } }))).puts[0].id;
  await apply(f, command("connectNodes", { from: a, to: b, label: "Link" }));
  await apply(f, command("arrange", { shapeIds: [a, b], layout: "row" }));
  const group = (await apply(f, command("groupNodes", { shapeIds: [a, b] }))).puts[0].id;
  await apply(f, command("removeNodes", { shapeIds: [group] }));
  const handle = await f.open();
  const records = handle.room.getCurrentSnapshot().documents.map((d) => d.state);
  assert.equal(records.some((r) => [a, b, group].includes(r.id as string)), false);
  assert.equal(records.some((r) => r.typeName === "binding"), false);
});

test("asset references cannot cross canvas ownership", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await assert.rejects(
    apply(
      f,
      command("addNode", {
        draft: { type: "image", title: "Image", src: `https://staging.getkan.dev/api/assets?id=${randomUUID()}`, alt: "Test" },
      }),
    ),
    (error: any) => error.status === 400 && /Asset belongs/.test(error.message),
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
});

test("durable queued turns are scoped and idempotent; conflicting retry denied", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const input = { operation: randomUUID(), message: "Create a note", anchors: [] };
  const first = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", input)),
    duplicate = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", input));
  assert.equal(first.id, duplicate.id);
  await assert.rejects(
    f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { ...input, message: "Different" })),
    /Conflicting/,
  );
  await assert.rejects(
    f.db.transaction((tx) => enqueue(tx, f.canvas, "viewer", { ...input, operation: randomUUID() })),
    /denied/,
  );
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_messages", []), 1);
});

test("a flush that fails after the store changed still yields one receipt and one shape on retry", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const handle = await f.open();
  const original: any = f.persistence.persist.bind(f.persistence);
  let failed = false;
  f.persistence.persist = async (...args: any[]) => {
    if (!failed && args[1].input?.actor) {
      failed = true;
      throw new Error("Synthetic crash during commit");
    }
    return original(...args);
  };
  const c = command("addNode", { draft: { type: "markdown", title: "Durable", body: "One mutation" } });
  await assert.rejects(apply(f, c), /Synthetic crash/);
  await until(() => handle.lastPersisted === handle.revision(), 5000);
  const receipt: any = await f.rooms.applyTool(f.canvas, { ...c, session: `session-${c.run}` });
  assert.equal(receipt.duplicate, true);
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_events WHERE room=$1 AND operation=$2", [f.canvas, c.operation]), 1);
  assert.equal(shapes(handle).length, 1);
  const stored = (await f.db.query("SELECT id FROM web_records WHERE room=$1 AND id=$2", [f.canvas, `shape:${c.operation}`])).rows;
  assert.equal(stored.length, 1);
  const event = (await f.persistence.replay(f.canvas)).find((e: any) => e.operation === c.operation);
  assert.ok(event.changes.puts.some((d: any) => d.state.id === `shape:${c.operation}`));
});

const fakeClient = () => {
  const runtime = new Map<string, { events: any[] }>();
  let sent = 0,
    created = 0;
  const client = {
    sessions: {
      async create() {
        const id = `session-${++created}`;
        runtime.set(id, { events: [] });
        return { session: { state: { sessionId: id } } };
      },
      attach(id: string) {
        return {
          async snapshot() {
            return runtime.get(id);
          },
          async send() {
            sent++;
            runtime.get(id)!.events.push({ type: "turn.started" });
          },
        };
      },
    },
  };
  return { client, runtime, sent: () => sent };
};

test("canvas queue serializes turns and recovers replies from a durable runtime snapshot", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { client, runtime, sent } = fakeClient();
  for (const message of ["First", "Second"])
    await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message }));
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent(), 1);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent(), 1);
  runtime.get("session-1")!.events.push(
    { type: "message.completed", meta: { id: "reply-1" }, data: { message: "Saved", finishReason: "stop" } },
    { type: "turn.completed" },
  );
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent(), 2);
  assert.equal(await count(f, "SELECT count(*)::int AS n FROM web_messages WHERE role='assistant'", []), 1);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent(), 2);
});

test("scheduler wake dispatches the queued run and survives dispatch failures", async (t) => {
  const f = await fixture();
  const { client, sent } = fakeClient();
  const logs: string[] = [];
  const log = { error: (name: string) => logs.push(name), warn() {}, info() {} };
  const scheduler = new Scheduler({
    db: f.db,
    config: {} as any,
    rooms: f.rooms,
    client,
    log,
    verifySession: async () => {},
  });
  scheduler.start();
  t.after(async () => {
    scheduler.stop();
    await f.close();
  });
  await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Go" }));
  scheduler.wake(f.canvas);
  scheduler.wake(f.canvas);
  await until(() => sent() === 1, 2000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent(), 1);

  const broken = new Scheduler({
    db: f.db,
    config: {} as any,
    rooms: f.rooms,
    client: { sessions: { create: () => { throw new Error("eve down"); } } },
    log,
    verifySession: async () => {},
  });
  broken.start();
  t.after(() => broken.stop());
  await f.db.query("UPDATE web_runs SET status='complete'");
  await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Again" }));
  broken.wake(f.canvas);
  await until(() => logs.includes("server.dispatch_failed"), 2000);
});

test("an unconfigured agent fails queued runs with a log instead of throwing", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "No agent" }));
  const logs: string[] = [];
  await dispatch(f.db, f.canvas, null, Date.now, async () => {}, { error: (name: string) => logs.push(name), warn() {} });
  assert.deepEqual(logs, ["server.agent_unconfigured"]);
  assert.equal((await f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0].status, "failed");
});

test("revoked queued author is denied before starting a paid session", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Denied" }));
  await f.db.query("DELETE FROM web_memberships WHERE user_id='editor'");
  const client = { sessions: { create() { throw Error("Must not invoke paid runtime"); } } };
  await dispatch(f.db, f.canvas, client);
  assert.equal((await f.db.query("SELECT status FROM web_runs")).rows[0].status, "denied");
});

test("successive additions use valid unique fractional indices beyond the tenth node", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (let i = 0; i < 21; i++)
    await apply(f, command("addNode", { draft: { type: "calendar", title: `Calendar ${i}`, events: [] } }));
  const list = shapes(await f.open());
  assert.equal(list.length, 21);
  assert.equal(new Set(list.map((s) => s.index)).size, 21);
});

test("commit rejects a membership revoked after an earlier authorization check", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await canvasAccess(f.db, f.canvas, "editor", "editor");
  await f.db.query("DELETE FROM web_memberships WHERE user_id='editor'");
  const c = command("addNode", { draft: { type: "markdown", title: "Denied at commit", body: "Never saved" } });
  await assert.rejects(apply(f, c), /Write access revoked/);
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
  assert.ok(!liveIds(await f.open()).includes(`shape:${c.operation}`));
});

test("cancelled or replaced runs cannot commit through an already accepted tool request", async (t) => {
  const f = await fixture(),
    run = randomUUID();
  t.after(() => f.close());
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,session_id,status) VALUES($1,$2,'editor',$3,'hash','Synthetic','old-session','cancelling')",
    [run, f.thread, randomUUID()],
  );
  const c = command("addNode", { draft: { type: "markdown", title: "Cancelled", body: "Never saved" } }, { run, session: "old-session" });
  await assert.rejects(f.rooms.applyTool(f.canvas, c), /Run cancelled/);
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
  assert.ok(!liveIds(await f.open()).includes(`shape:${c.operation}`));
});

test("rich node updates normalize interactive state when their data changes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const table = (
    await apply(f, command("addNode", { draft: { type: "table", title: "Table", columns: ["A", "B"], rows: [[1, 2], [3, 4]] } }))
  ).puts[0].id;
  await apply(f, command("updateNode", { shapeId: table, patch: { type: "table", selectedRows: [1], highlightRow: 1, sortBy: { column: 1, dir: "asc" } } }));
  await apply(f, command("updateNode", { shapeId: table, patch: { type: "table", columns: ["A"], rows: [[1]] } }));
  const result: any = (await f.open()).room.getCurrentSnapshot().documents.find((d) => d.state.id === table)!.state;
  assert.deepEqual(result.props.selectedRows, []);
  assert.equal(result.props.highlightRow, -1);
  assert.equal(result.props.sortBy, null);
});

test("Mermaid parses supported diagrams into one atomic native graph and recovers without duplication", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const handle = await f.open();
  for (const source of [
    "flowchart LR\nA[Start] --> B{Done}",
    "sequenceDiagram\nAlice->>Bob: Hello",
    "stateDiagram-v2\n[*] --> Active\nActive --> [*]",
    "mindmap\n  root((Kan))\n    Canvas\n    Chat",
  ]) {
    const c = command("addMermaidDiagram", { source });
    c.diagram = await parseDiagram(c.input);
    const before = handle.revision();
    const plan = await apply(f, c);
    assert.equal(handle.revision(), before + 1);
    assert.ok(plan.puts.some((r: any) => r.type === "geo"));
    assert.ok(plan.puts.some((r: any) => r.type === "arrow"));
    assert.equal(new Set(plan.puts.map((r: any) => r.id)).size, plan.puts.length);
    for (const record of plan.puts) assert.deepEqual((schema.types as any)[record.typeName].validate(record), record);
    const again: any = await f.rooms.applyTool(f.canvas, { ...c, session: `session-${c.run}` });
    assert.equal(again.duplicate, true);
    assert.equal(handle.revision(), before + 1);
  }
  const revision = handle.revision();
  await assert.rejects(parseDiagram({ source: "flowchart LR\nA -->" }));
  assert.equal(handle.revision(), revision);
  assert.equal((await parseDiagram({ source: "flowchart LR\nA --> B" })).nodes.length, 2);
});

test("retry checks saved receipts and retry ceiling before retiring the old runtime", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Synthetic retry" }));
  await f.db.query("UPDATE web_runs SET status='failed',session_id='old' WHERE id=$1", [run.id]);
  await f.open();
  let resets = 0;
  const client = { sessions: { attach() { return { async reset() { resets++; } }; } } };
  const retry = () => f.db.transaction((tx) => retryRun(tx, f.canvas, "editor", run.id, "new-auth", client));
  await f.db.query("INSERT INTO web_events(room,revision,operation,input_hash,changes) VALUES($1,1,$2,'hash','{}')", [f.canvas, run.id + ":saved"]);
  await assert.rejects(retry(), /saved changes/);
  assert.equal(resets, 0);
  await f.db.query("DELETE FROM web_events WHERE room=$1", [f.canvas]);
  await f.db.query("UPDATE web_runs SET retry_count=2 WHERE id=$1", [run.id]);
  await assert.rejects(retry(), /retry limit/);
  assert.equal(resets, 0);
  await f.db.query("UPDATE web_runs SET retry_count=0 WHERE id=$1", [run.id]);
  await retry();
  assert.equal(resets, 1);
  const row = (await f.db.query("SELECT * FROM web_runs WHERE id=$1", [run.id])).rows[0];
  assert.equal(row.status, "queued");
  assert.equal(row.session_id, null);
  assert.equal(row.retry_count, 1);
  await assert.rejects(retry(), /Only failed/);
  assert.equal(resets, 1);
});

test("ambiguous dispatch is never resent and a parked session becomes recoverable", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const run = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Uncertain dispatch" }));
  let sends = 0;
  const client = {
    sessions: {
      async create() { return { session: { state: { sessionId: "parked" } } }; },
      attach() {
        return {
          async send() { sends++; throw Error("Unknown acceptance"); },
          async snapshot() { return { events: [] }; },
        };
      },
    },
  };
  await dispatch(f.db, f.canvas, client);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sends, 1);
  assert.equal((await f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0].status, "dispatching");
  await f.db.query("UPDATE web_runs SET dispatched_at=now()-interval '6 minutes' WHERE id=$1", [run.id]);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sends, 1);
  assert.equal((await f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0].status, "failed");
});

test("stream follows the first actual turn after an initially parked waiting event", () => {
  const boundary = new RunStreamBoundary();
  assert.equal(boundary.settled({ type: "session.waiting" }), false);
  assert.equal(boundary.settled({ type: "turn.started" }), false);
  assert.equal(boundary.settled({ type: "message.appended" }), false);
  assert.equal(boundary.settled({ type: "actions.requested" }), false);
  assert.equal(boundary.settled({ type: "turn.completed" }), true);
  assert.equal(new RunStreamBoundary().settled({ type: "session.failed" }), true);
});

