import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import { migration } from "../src/migration.mjs";
import { enqueue, dispatch } from "../../../apps/web/src/lib/runs.ts";
import {
  startMeeting,
  ingestSegments,
  setMeetingStatus,
  meetingState,
  readMeetingContext,
  CONTEXT_SETTLE_MS,
  CONTEXT_MAX_WAIT_MS,
} from "../../../apps/web/src/lib/meeting.ts";

const T0 = 1_800_000_000_000;
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await new Persistence(db).migrate();
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
  const meeting = await db.transaction((tx) =>
    startMeeting(tx, canvas, "editor", { label: "Standup" }),
  );
  const runtime = new Map(),
    sends = [];
  let created = 0;
  const client = {
    sessions: {
      async create() {
        const id = `s${++created}`;
        runtime.set(id, { events: [] });
        return { session: { state: { sessionId: id } } };
      },
      attach(id) {
        return {
          async snapshot() {
            return runtime.get(id);
          },
          async send(prompt) {
            sends.push({ id, prompt });
            runtime.get(id).events.push({ type: "turn.started" });
          },
        };
      },
    },
  };
  const complete = (id) =>
    runtime.get(id).events.push(
      {
        type: "message.completed",
        meta: { id: `reply-${id}` },
        data: { message: "Done", finishReason: "stop" },
      },
      { type: "turn.completed" },
    );
  const f = { db, canvas, meeting, client, sends, runtime, complete };
  f.ingest = (segments, at = T0) =>
    db.transaction((tx) =>
      ingestSegments(tx, canvas, "editor", { session: meeting.id, segments }, () => at),
    );
  f.dispatch = (at) => dispatch(db, canvas, client, () => at);
  f.session = async () =>
    (await db.query("SELECT * FROM web_meeting_sessions WHERE id=$1", [meeting.id])).rows[0];
  f.runs = async () =>
    (await db.query("SELECT * FROM web_runs WHERE kind='context' ORDER BY created_at,id")).rows;
  return f;
}
const seg = (i, final = true, text = `text ${i}`) => ({
  sourceId: `src-${i}`,
  speaker: "Ana",
  text,
  startedAtMs: i * 1000,
  final,
});

test("segment upsert outcomes, monotonic seq and final-only cursor", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.db.transaction((tx) => startMeeting(tx, f.canvas, "editor", { label: "Again" })),
    /already active/,
  );
  let r = await f.ingest([seg(1, false, "hel")]);
  assert.deepEqual(r.outcomes, [{ sourceId: "src-1", seq: 1, outcome: "inserted" }]);
  assert.equal(r.pendingCursor, 0);
  r = await f.ingest([seg(1, true, "hello")]);
  assert.equal(r.outcomes[0].outcome, "replaced");
  assert.equal(r.pendingCursor, 1);
  const row = (await f.db.query("SELECT * FROM web_transcript_segments")).rows[0];
  assert.equal(row.revision, 1);
  assert.equal(row.seq, 1);
  r = await f.ingest([seg(1, true, "hello")]);
  assert.equal(r.outcomes[0].outcome, "duplicate");
  r = await f.ingest([seg(1, false, "hel")]);
  assert.equal(r.outcomes[0].outcome, "ignored-stale");
  assert.equal(
    (await f.db.query("SELECT text,final FROM web_transcript_segments")).rows[0].text,
    "hello",
  );
  r = await f.ingest([seg(2, false), seg(3, true)]);
  assert.deepEqual(r.outcomes.map((o) => o.seq), [2, 3]);
  assert.equal(r.pendingCursor, 3);
  const state = await f.db.transaction((tx) => meetingState(tx, f.canvas, "viewer"));
  assert.deepEqual(state.segments.map((s) => s.seq), [1, 2, 3]);
  assert.equal(state.session.id, f.meeting.id);
  await assert.rejects(
    f.db.transaction((tx) =>
      ingestSegments(tx, f.canvas, "viewer", { session: f.meeting.id, segments: [seg(9)] }),
    ),
    /denied/,
  );
});

test("settled transcript schedules one context run after the settle window", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1), seg(2), seg(3)]);
  assert.deepEqual(await f.dispatch(T0 + 1000), { pending: true });
  assert.equal((await f.runs()).length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.dispatch(T0 + CONTEXT_SETTLE_MS + 1000)).pending, true);
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "context");
  assert.equal(runs[0].context_from, 1);
  assert.equal(runs[0].context_to, 3);
  assert.equal(runs[0].meeting_session, f.meeting.id);
  assert.equal(runs[0].auth_session_id, null);
  assert.equal(runs[0].user_id, "editor");
  assert.match(runs[0].prompt, /segments 1–3 arrived/);
  assert.equal(f.sends.length, 1);
  assert.equal((await f.session()).processed_cursor, 3);
  assert.equal((await f.session()).context_runs, 1);
  const message = (
    await f.db.query("SELECT * FROM web_messages WHERE role='context'")
  ).rows[0];
  assert.equal(message.run, runs[0].id);
  assert.deepEqual(message.evidence, [{ session: f.meeting.id, from: 1, to: 3 }]);
});

test("continuous speech is flushed after the maximum wait", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) await f.ingest([seg(i + 1)], T0 + i * 2000);
  const lastAt = T0 + 24 * 2000;
  assert.deepEqual(await f.dispatch(T0 + CONTEXT_MAX_WAIT_MS - 1), { pending: true });
  assert.equal((await f.runs()).length, 0);
  assert.ok(T0 + CONTEXT_MAX_WAIT_MS - lastAt < CONTEXT_SETTLE_MS);
  await f.dispatch(T0 + CONTEXT_MAX_WAIT_MS);
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].context_from, 1);
  assert.equal(runs[0].context_to, 25);
});

test("segments arriving during a run get their own follow-up run", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1), seg(2)]);
  await f.dispatch(T0 + 9000);
  assert.equal(f.sends.length, 1);
  const t1 = T0 + 10000;
  await f.ingest([seg(3), seg(4), seg(5)], t1);
  assert.equal((await f.session()).pending_cursor, 5);
  assert.equal((await f.dispatch(t1 + 9000)).pending, true);
  assert.equal(f.sends.length, 1);
  assert.equal((await f.runs()).length, 1);
  f.complete("s1");
  assert.equal((await f.dispatch(t1 + 2000)).pending, true);
  assert.equal(f.sends.length, 1);
  const first = (await f.runs())[0];
  assert.equal(first.status, "complete");
  const reply = (await f.db.query("SELECT * FROM web_messages WHERE role='assistant'")).rows[0];
  assert.deepEqual(reply.evidence, [{ session: f.meeting.id, from: 1, to: 2 }]);
  await f.dispatch(t1 + 9000);
  const runs = await f.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].context_from, 3);
  assert.equal(runs[1].context_to, 5);
  assert.equal(f.sends.length, 2);
  f.complete("s2");
  assert.deepEqual(await f.dispatch(t1 + 20000), { pending: false });
  assert.equal((await f.runs()).length, 2);
});

test("explicit requests run before due meeting context", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1)]);
  await f.db.transaction((tx) =>
    enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Explicit ask" }),
  );
  await f.dispatch(T0 + 20000);
  assert.deepEqual(f.sends.map((s) => s.prompt), ["Explicit ask"]);
  assert.equal((await f.runs()).length, 0);
  f.complete("s1");
  await f.dispatch(T0 + 21000);
  assert.equal(f.sends.length, 2);
  assert.match(f.sends[1].prompt, /^Meeting context segments 1–1/);
});

test("paused and ended meetings never schedule runs", async (t) => {
  const f = await fixture(t);
  const status = (status) =>
    f.db.transaction((tx) =>
      setMeetingStatus(tx, f.canvas, "editor", { session: f.meeting.id, status }),
    );
  await status("paused");
  const r = await f.ingest([seg(1)]);
  assert.equal(r.pendingCursor, 1);
  assert.deepEqual(await f.dispatch(T0 + 20000), { pending: false });
  assert.equal((await f.runs()).length, 0);
  const resumed = await status("listening");
  assert.equal(resumed.pause_reason, null);
  await f.dispatch(T0 + 20000);
  assert.equal((await f.runs()).length, 1);
  f.complete("s1");
  await f.dispatch(T0 + 21000);
  await f.ingest([seg(2)], T0 + 22000);
  const ended = await status("ended");
  assert.equal(ended.status, "ended");
  assert.ok(ended.ended_at);
  await assert.rejects(f.ingest([seg(3)], T0 + 23000), /ended/);
  await assert.rejects(status("listening"), /ended/);
  await f.dispatch(T0 + 40000);
  assert.equal((await f.runs()).length, 1);
  assert.equal(f.sends.length, 1);
});

test("a context run whose creator lost access is denied without starting a session", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1)]);
  await f.db.query("DELETE FROM web_memberships WHERE user_id='editor'");
  const client = {
    sessions: {
      create() {
        throw Error("Must not invoke paid runtime");
      },
    },
  };
  await dispatch(f.db, f.canvas, client, () => T0 + 20000);
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "denied");
  assert.equal(runs[0].session_id, null);
});

test("the per-meeting context run cap pauses the session instead of scheduling", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1)]);
  await f.db.query("UPDATE web_meeting_sessions SET context_runs=20");
  assert.deepEqual(await f.dispatch(T0 + 20000), { pending: false });
  const session = await f.session();
  assert.equal(session.status, "paused");
  assert.equal(session.pause_reason, "budget");
  assert.equal((await f.runs()).length, 0);
  assert.equal(f.sends.length, 0);
});

test("the global staging turn cap also pauses meetings", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++)
    await f.db.transaction((tx) =>
      enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: `Turn ${i}` }),
    );
  await f.db.query("UPDATE web_runs SET status='complete'");
  await f.ingest([seg(1)]);
  await f.dispatch(T0 + 20000);
  const session = await f.session();
  assert.equal(session.status, "paused");
  assert.equal(session.pause_reason, "budget");
  assert.equal((await f.runs()).length, 0);
});

test("readMeetingContext returns only final segments in range and rejects request runs", async (t) => {
  const f = await fixture(t);
  await f.ingest([seg(1), seg(2), seg(3, false), seg(4), seg(5)]);
  await f.dispatch(T0 + 20000);
  const run = (await f.runs())[0];
  assert.equal(run.context_to, 5);
  const read = (input) => f.db.transaction((tx) => readMeetingContext(tx, run, input));
  const all = await read({});
  assert.deepEqual(all.segments.map((s) => s.seq), [1, 2, 4, 5]);
  assert.deepEqual(all.range, { from: 1, to: 5 });
  assert.equal(all.session.label, "Standup");
  assert.equal(all.segments[0].startedAtMs, 1000);
  assert.deepEqual((await read({ from: 2, to: 4 })).segments.map((s) => s.seq), [2, 4]);
  assert.deepEqual((await read({ limit: 1 })).segments.map((s) => s.seq), [1]);
  await assert.rejects(read({ limit: 500 }), /Invalid/);
  const request = await f.db.transaction((tx) =>
    enqueue(tx, f.canvas, "editor", { operation: randomUUID(), message: "Plain" }),
  );
  const row = (await f.db.query("SELECT * FROM web_runs WHERE id=$1", [request.id])).rows[0];
  await assert.rejects(
    f.db.transaction((tx) => readMeetingContext(tx, row, {})),
    /No meeting context/,
  );
});

test("migration string matches the concatenated migration files", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).sort();
  assert.ok(files.includes("003.sql"));
  assert.equal(
    migration,
    files.map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n"),
  );
});
