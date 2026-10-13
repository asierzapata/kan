import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import { enqueue } from "../../../apps/server/src/runs.ts";
import { runCeiling, contextRunCap } from "../../../apps/server/src/policy.ts";

const original = { ...process.env };
test.afterEach(() => {
  for (const key of ["KAN_ENV", "KAN_RUN_CEILING", "KAN_CONTEXT_RUN_CAP"])
    original[key] === undefined ? delete process.env[key] : (process.env[key] = original[key]);
});
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await new Persistence(db).migrate();
  const workspace = randomUUID(),
    canvas = randomUUID();
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,'S')", [workspace]);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,'C')", [canvas, workspace]);
  await db.query("INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,'editor','e@example.test','editor')", [workspace]);
  const ask = (i) =>
    db.transaction((tx) =>
      enqueue(tx, canvas, "editor", { operation: randomUUID(), message: `Turn ${i}` }),
    );
  return { db, ask };
}
const fill = async (f, n) => {
  for (let i = 0; i < n; i++) await f.ask(i);
};

test("production without an explicit run ceiling fails loudly", async (t) => {
  process.env.KAN_ENV = "production";
  delete process.env.KAN_RUN_CEILING;
  const f = await fixture(t);
  await assert.rejects(f.ask(0), /KAN_RUN_CEILING must be set in production \(0 = unlimited\)/);
});

test("a zero ceiling means unlimited", async (t) => {
  process.env.KAN_ENV = "production";
  process.env.KAN_RUN_CEILING = "0";
  const f = await fixture(t);
  await fill(f, 21);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM web_runs")).rows[0].n, 21);
});

test("staging defaults to a ceiling of twenty runs", async (t) => {
  process.env.KAN_ENV = "staging";
  delete process.env.KAN_RUN_CEILING;
  const f = await fixture(t);
  await fill(f, 20);
  await assert.rejects(f.ask(20), (error) => error.status === 429);
});

test("explicit ceilings and the context cap are read on every call", () => {
  process.env.KAN_ENV = "staging";
  process.env.KAN_RUN_CEILING = "5";
  assert.equal(runCeiling(), 5);
  process.env.KAN_RUN_CEILING = "abc";
  assert.throws(() => runCeiling(), /integer/);
  assert.equal(contextRunCap(), 20);
  process.env.KAN_CONTEXT_RUN_CAP = "3";
  assert.equal(contextRunCap(), 3);
});
