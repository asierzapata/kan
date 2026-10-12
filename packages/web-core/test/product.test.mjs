import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import {
  canvasAccess,
  workspaceAccess,
} from "../../../apps/web/src/lib/access.ts";
import { enqueue, dispatch } from "../../../apps/web/src/lib/runs.ts";
import {
  Coordinator,
  recordChanges,
} from "../../../apps/realtime/src/coordinator.mjs";
import { planTool } from "../../../apps/realtime/src/tools.ts";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import * as props from "../../../apps/desktop/src/nodes/shapes/types.ts";
const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    ...Object.fromEntries(
      [
        "markdown",
        "chart",
        "table",
        "image",
        "map",
        "logo",
        "timeline",
        "calendar",
      ].map((type) => [`kan-${type}`, { props: props[`${type}ShapeProps`] }]),
    ),
  },
});
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const persistence = new Persistence(db);
  await persistence.migrate();
  const workspace = randomUUID(),
    canvas = randomUUID();
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,$2)", [
    workspace,
    "Synthetic",
  ]);
  await db.query(
    "INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,$3)",
    [canvas, workspace, "Fixture"],
  );
  for (const role of ["owner", "editor", "viewer"])
    await db.query(
      "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,$4)",
      [workspace, role, `${role}@example.test`, role],
    );
  const room = await Coordinator.open(persistence, canvas, { schema });
  t.after(() => room.close());
  return { db, persistence, workspace, canvas, room };
}
const command = (name, input) => ({
  name,
  input,
  operation: randomUUID(),
  run: randomUUID(),
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
test("workspace roles, denied writes, cross-workspace access and revocation", async (t) => {
  const f = await fixture(t);
  assert.equal((await canvasAccess(f.db, f.canvas, "viewer")).role, "viewer");
  await assert.rejects(
    canvasAccess(f.db, f.canvas, "viewer", "editor"),
    /denied/,
  );
  await assert.rejects(
    workspaceAccess(f.db, f.workspace, "outsider"),
    /denied/,
  );
  await assert.rejects(
    workspaceAccess(f.db, f.workspace, "editor", "owner"),
    /denied/,
  );
  await f.db.query(
    "DELETE FROM web_memberships WHERE workspace=$1 AND user_id=$2",
    [f.workspace, "editor"],
  );
  await assert.rejects(canvasAccess(f.db, f.canvas, "editor"), /denied/);
});
test("record-only events, recovery, duplicate receipt and conflicting operation", async (t) => {
  const f = await fixture(t);
  const c = command("addNode", {
    draft: { type: "markdown", title: "Hello", body: "Persisted" },
  });
  const plan = await apply(f, c);
  const event = (await f.persistence.replay(f.canvas))[0];
  assert.equal(event.changes.puts.length, 1);
  assert.equal("snapshot" in event, false);
  assert.equal(event.changes.puts[0].state.props.body, "Persisted");
  await f.room.transact(
    c.operation,
    { name: c.name, input: c.input },
    () => {
      throw Error("Must not reapply");
    },
    true,
  );
  assert.equal(f.room.revision, 1);
  await assert.rejects(
    f.persistence.receipt(f.canvas, c.operation, { different: true }),
    /Conflicting/,
  );
  const recovered = await Coordinator.open(f.persistence, f.canvas, { schema });
  t.after(() => recovered.close());
  assert.deepEqual(
    recovered.room.getCurrentSnapshot().documents.map((d) => d.state),
    f.room.room.getCurrentSnapshot().documents.map((d) => d.state),
  );
  assert.equal(plan.puts[0].meta.provenance.byUserId, "editor");
});
test("fencing and failed commits never acknowledge or retain cache", async (t) => {
  const f = await fixture(t);
  const newer = await Coordinator.open(f.persistence, f.canvas, { schema });
  t.after(() => newer.close());
  await assert.rejects(
    apply(f, command("addNode", { draft: { type: "geo", geo: "rectangle" } })),
    /Fenced/,
  );
  assert.equal(f.room.dead, true);
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
});
test("record limits roll back document and event atomically", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.persistence.commit(
      f.canvas,
      f.room.epoch,
      0,
      "oversized",
      {},
      {
        puts: [],
        removes: Array.from({ length: 501 }, (_, i) => `shape:${i}`),
        metadata: {},
      },
    ),
    /bounded/,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
  assert.equal(
    (await f.db.query("SELECT revision FROM web_rooms WHERE id=$1", [f.canvas]))
      .rows[0].revision,
    0,
  );
});
test("rich-node types and interactive calendar state survive record recovery", async (t) => {
  const f = await fixture(t);
  const drafts = [
    {
      type: "chart",
      title: "Chart",
      spec: { kind: "bar", x: "x", series: [{ key: "y" }] },
      data: [{ x: "A", y: 2 }],
    },
    { type: "table", title: "Table", columns: ["A"], rows: [[1]] },
    { type: "map", title: "Map", markers: [{ lat: 1, lng: 2, label: "Test" }] },
    { type: "logo", domain: "example.com" },
    {
      type: "timeline",
      title: "Timeline",
      events: [{ id: "a", title: "Event", start: "2026-10-12" }],
    },
    { type: "calendar", title: "Calendar", events: [] },
    {
      type: "image",
      title: "Image",
      src: "https://example.com/image.png",
      alt: "Test",
    },
    { type: "geo", geo: "ellipse" },
  ];
  let calendar;
  for (const draft of drafts) {
    const plan = await apply(f, command("addNode", { draft }));
    if (draft.type === "calendar") calendar = plan.puts[0].id;
  }
  await apply(
    f,
    command("updateNode", {
      shapeId: calendar,
      patch: { type: "calendar", selectedDate: "2027-01-12" },
    }),
  );
  const restored = await Coordinator.open(f.persistence, f.canvas, { schema });
  t.after(() => restored.close());
  const shapes = restored.room
    .getCurrentSnapshot()
    .documents.map((d) => d.state)
    .filter((d) => d.typeName === "shape");
  assert.equal(shapes.length, 8);
  assert.equal(shapes.find((s) => s.id === calendar).props.month, "2027-01");
});
test("connect, arrange, group and remove maintain record graph", async (t) => {
  const f = await fixture(t);
  const a = (
      await apply(
        f,
        command("addNode", { draft: { type: "geo", geo: "rectangle" } }),
      )
    ).puts[0].id,
    b = (
      await apply(
        f,
        command("addNode", {
          draft: { type: "markdown", title: "B", body: "Body" },
        }),
      )
    ).puts[0].id;
  await apply(f, command("connectNodes", { from: a, to: b, label: "Link" }));
  await apply(f, command("arrange", { shapeIds: [a, b], layout: "row" }));
  const group = (await apply(f, command("groupNodes", { shapeIds: [a, b] })))
    .puts[0].id;
  await apply(f, command("removeNodes", { shapeIds: [group] }));
  const records = f.room.room
    .getCurrentSnapshot()
    .documents.map((d) => d.state);
  assert.equal(
    records.some((r) => [a, b, group].includes(r.id)),
    false,
  );
  assert.equal(
    records.some((r) => r.typeName === "binding"),
    false,
  );
});
test("asset references cannot cross canvas ownership", async (t) => {
  const f = await fixture(t);
  const asset = randomUUID();
  await assert.rejects(
    apply(
      f,
      command("addNode", {
        draft: {
          type: "image",
          title: "Image",
          src: `https://staging.getkan.dev/api/assets?id=${asset}`,
          alt: "Test",
        },
      }),
    ),
    /Asset belongs/,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
});
test("durable queued turns are scoped and idempotent; conflicting retry denied", async (t) => {
  const f = await fixture(t);
  const input = {
    operation: randomUUID(),
    message: "Create a note",
    anchors: [],
  };
  const first = await f.db.transaction((tx) =>
      enqueue(tx, f.canvas, "editor", input),
    ),
    duplicate = await f.db.transaction((tx) =>
      enqueue(tx, f.canvas, "editor", input),
    );
  assert.equal(first.id, duplicate.id);
  await assert.rejects(
    f.db.transaction((tx) =>
      enqueue(tx, f.canvas, "editor", { ...input, message: "Different" }),
    ),
    /Conflicting/,
  );
  await assert.rejects(
    f.db.transaction((tx) =>
      enqueue(tx, f.canvas, "viewer", { ...input, operation: randomUUID() }),
    ),
    /denied/,
  );
  assert.equal(
    (await f.db.query("SELECT count(*)::int AS count FROM web_messages"))
      .rows[0].count,
    1,
  );
});
test("diff excludes unchanged document bodies and retains removals", () => {
  const doc = { state: { id: "shape:a", props: { body: "large" } } },
    before = { clock: 1, documents: [doc] },
    after = { clock: 2, documents: [] };
  assert.deepEqual(recordChanges(before, after), {
    puts: [],
    removes: ["shape:a"],
    metadata: { clock: 2 },
  });
});

test("crash after commit is recovered and stable tool identity is not applied twice", async (t) => {
  const f = await fixture(t);
  f.room.options.afterCommit = () => {
    throw Error("Synthetic crash after commit");
  };
  const c = command("addNode", {
    draft: { type: "markdown", title: "Durable", body: "One mutation" },
  });
  await assert.rejects(apply(f, c), /Synthetic crash/);
  const recovered = await Coordinator.open(f.persistence, f.canvas, { schema });
  t.after(() => recovered.close());
  await recovered.transact(
    c.operation,
    { name: c.name, input: c.input },
    () => {
      throw Error("Duplicate applied");
    },
    true,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 1);
  assert.equal(
    recovered.room
      .getCurrentSnapshot()
      .documents.filter((d) => d.state.typeName === "shape").length,
    1,
  );
});
test("canvas queue serializes turns and recovers replies from a durable runtime snapshot", async (t) => {
  const f = await fixture(t),
    runtime = new Map();
  let sent = 0,
    created = 0;
  const client = {
    sessions: {
      async create() {
        const id = `session-${++created}`;
        runtime.set(id, { events: [] });
        return { session: { state: { sessionId: id } } };
      },
      attach(id) {
        return {
          async snapshot() {
            return runtime.get(id);
          },
          async send() {
            sent++;
            runtime.get(id).events.push({ type: "turn.started" });
          },
        };
      },
    },
  };
  await f.db.transaction((tx) =>
    enqueue(tx, f.canvas, "editor", {
      operation: randomUUID(),
      message: "First",
    }),
  );
  await f.db.transaction((tx) =>
    enqueue(tx, f.canvas, "editor", {
      operation: randomUUID(),
      message: "Second",
    }),
  );
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent, 1);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent, 1);
  runtime.get("session-1").events.push(
    {
      type: "message.completed",
      meta: { id: "reply-1" },
      data: { message: "Saved", finishReason: "stop" },
    },
    { type: "turn.completed" },
  );
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent, 2);
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS count FROM web_messages WHERE role='assistant'",
      )
    ).rows[0].count,
    1,
  );
  await dispatch(f.db, f.canvas, client);
  assert.equal(sent, 2);
});
test("revoked queued author is denied before starting a paid session", async (t) => {
  const f = await fixture(t);
  await f.db.transaction((tx) =>
    enqueue(tx, f.canvas, "editor", {
      operation: randomUUID(),
      message: "Denied",
    }),
  );
  await f.db.query("DELETE FROM web_memberships WHERE user_id='editor'");
  const client = {
    sessions: {
      create() {
        throw Error("Must not invoke paid runtime");
      },
    },
  };
  await dispatch(f.db, f.canvas, client);
  assert.equal(
    (await f.db.query("SELECT status FROM web_runs")).rows[0].status,
    "denied",
  );
});

test("successive additions use valid unique fractional indices beyond the tenth node", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 21; i++)
    await apply(
      f,
      command("addNode", {
        draft: { type: "calendar", title: `Calendar ${i}`, events: [] },
      }),
    );
  const shapes = f.room.room
    .getCurrentSnapshot()
    .documents.map((d) => d.state)
    .filter((d) => d.typeName === "shape");
  assert.equal(shapes.length, 21);
  assert.equal(new Set(shapes.map((s) => s.index)).size, 21);
});

test("commit transaction rejects a membership revoked after an earlier authorization check", async (t) => {
  const f = await fixture(t);
  await canvasAccess(f.db, f.canvas, "editor", "editor");
  await f.db.query("DELETE FROM web_memberships WHERE user_id='editor'");
  const c = command("addNode", {
      draft: {
        type: "markdown",
        title: "Denied at commit",
        body: "Never saved",
      },
    }),
    plan = planTool(f.room.room, schema, c);
  await assert.rejects(
    f.room.transact(
      c.operation,
      { actor: { user: "editor" }, name: c.name, input: c.input },
      (room) =>
        room.updateStore((store) =>
          plan.puts.forEach((record) => store.put(record)),
        ),
      true,
    ),
    /Write access revoked/,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
});
test("cancelled or replaced runs cannot commit through an already accepted tool request", async (t) => {
  const f = await fixture(t),
    thread = randomUUID(),
    run = randomUUID();
  await f.db.query(
    "INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,$3)",
    [thread, f.canvas, "Fixture"],
  );
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,session_id,status) VALUES($1,$2,'editor',$3,'hash','Synthetic','old-session','cancelling')",
    [run, thread, randomUUID()],
  );
  const c = command("addNode", {
      draft: { type: "markdown", title: "Cancelled", body: "Never saved" },
    }),
    plan = planTool(f.room.room, schema, c);
  await assert.rejects(
    f.room.transact(
      c.operation,
      { actor: { user: "editor", run, session: "old-session" } },
      (room) =>
        room.updateStore((store) =>
          plan.puts.forEach((record) => store.put(record)),
        ),
      true,
    ),
    /Run cancelled/,
  );
  assert.equal((await f.persistence.replay(f.canvas)).length, 0);
});
test("rich node updates normalize interactive state when their data changes", async (t) => {
  const f = await fixture(t);
  const table = (
    await apply(
      f,
      command("addNode", {
        draft: {
          type: "table",
          title: "Table",
          columns: ["A", "B"],
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    )
  ).puts[0].id;
  await apply(
    f,
    command("updateNode", {
      shapeId: table,
      patch: {
        type: "table",
        selectedRows: [1],
        highlightRow: 1,
        sortBy: { column: 1, dir: "asc" },
      },
    }),
  );
  await apply(
    f,
    command("updateNode", {
      shapeId: table,
      patch: { type: "table", columns: ["A"], rows: [[1]] },
    }),
  );
  const result = f.room.room
    .getCurrentSnapshot()
    .documents.find((d) => d.state.id === table).state;
  assert.deepEqual(result.props.selectedRows, []);
  assert.equal(result.props.highlightRow, -1);
  assert.equal(result.props.sortBy, null);
});

test("Mermaid parses supported diagrams into one atomic native graph and recovers without duplication", async (t) => {
  const { parseDiagram } = await import("../../../apps/web/src/lib/diagrams.ts");
  const f = await fixture(t);
  for (const source of [
    "flowchart LR\nA[Start] --> B{Done}",
    "sequenceDiagram\nAlice->>Bob: Hello",
    "stateDiagram-v2\n[*] --> Active\nActive --> [*]",
    "mindmap\n  root((Kan))\n    Canvas\n    Chat",
  ]) {
    const c = command("addMermaidDiagram", { source });
    c.diagram = await parseDiagram(c.input);
    const before = f.room.revision;
    const plan = await apply(f, c);
    assert.equal(f.room.revision, before + 1);
    assert.ok(plan.puts.some((r) => r.type === "geo"));
    assert.ok(plan.puts.some((r) => r.type === "arrow"));
    assert.equal(new Set(plan.puts.map((r) => r.id)).size, plan.puts.length);
    for (const record of plan.puts) assert.deepEqual(schema.types[record.typeName].validate(record), record);
    await f.room.transact(c.operation, { name: c.name, input: c.input }, () => {
      throw Error("Must not duplicate diagram");
    }, true);
    assert.equal(f.room.revision, before + 1);
  }
  const revision = f.room.revision;
  await assert.rejects(parseDiagram({ source: "flowchart LR\nA -->" }));
  assert.equal(f.room.revision, revision);
  // A parser failure must not poison its serialized queue.
  assert.equal((await parseDiagram({ source: "flowchart LR\nA --> B" })).nodes.length, 2);
});

test("retry checks saved receipts and retry ceiling before retiring the old runtime", async (t) => {
  const { retryRun } = await import("../../../apps/web/src/lib/runs.ts");
  const f = await fixture(t);
  const run = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", {
    operation: randomUUID(), message: "Synthetic retry",
  }));
  await f.db.query("UPDATE web_runs SET status='failed',session_id='old' WHERE id=$1", [run.id]);
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
  const f = await fixture(t);
  const run = await f.db.transaction((tx) => enqueue(tx, f.canvas, "editor", {
    operation: randomUUID(), message: "Uncertain dispatch",
  }));
  let sends = 0;
  const client = { sessions: {
    async create() { return { session: { state: { sessionId: "parked" } } }; },
    attach() { return {
      async send() { sends++; throw Error("Unknown acceptance"); },
      async snapshot() { return { events: [] }; },
    }; },
  } };
  await dispatch(f.db, f.canvas, client);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sends, 1);
  assert.equal((await f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0].status, "dispatching");
  await f.db.query("UPDATE web_runs SET dispatched_at=now()-interval '6 minutes' WHERE id=$1", [run.id]);
  await dispatch(f.db, f.canvas, client);
  assert.equal(sends, 1);
  assert.equal((await f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0].status, "failed");
});

test("stream follows the first actual turn after an initially parked waiting event", async () => {
  const { RunStreamBoundary } = await import("../../../apps/web/src/lib/run-stream.ts");
  const boundary = new RunStreamBoundary();
  assert.equal(boundary.settled({ type: "session.waiting" }), false);
  assert.equal(boundary.settled({ type: "turn.started" }), false);
  assert.equal(boundary.settled({ type: "message.appended" }), false);
  assert.equal(boundary.settled({ type: "actions.requested" }), false);
  assert.equal(boundary.settled({ type: "turn.completed" }), true);
  assert.equal(new RunStreamBoundary().settled({ type: "session.failed" }), true);
});
