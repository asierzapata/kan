import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { Persistence } from "../src/persistence.mjs";
import { migration } from "../src/migration.mjs";

const read = (name) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const tables = (db) =>
  db
    .query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'web_%' ORDER BY 1")
    .then((r) => r.rows.map((row) => row.table_name));

test("migrate is idempotent", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const persistence = new Persistence(db);
  await persistence.migrate();
  const workspace = randomUUID();
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,'Seed')", [workspace]);
  const shape = async () => ({
    tables: await tables(db),
    columns: (
      await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name LIKE 'web_%' ORDER BY 1,2")
    ).rows.length,
    workspaces: (await db.query("SELECT count(*)::int AS n FROM web_workspaces")).rows[0].n,
  });
  const first = await shape();
  await persistence.migrate();
  await persistence.migrate();
  assert.deepEqual(await shape(), first);
});

test("a database at migration 002 migrates forward and keeps its rows", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(read("001.sql"));
  await db.exec(read("002.sql"));
  const [workspace, canvas, thread, run, operation] = Array.from({ length: 5 }, () => randomUUID());
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,'Old')", [workspace]);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,'Old canvas')", [canvas, workspace]);
  await db.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,'Old thread')", [thread, canvas]);
  await db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt) VALUES($1,$2,'u',$3,'h','Old prompt')",
    [run, thread, operation],
  );
  await db.query(
    "INSERT INTO web_messages(id,thread,run,user_id,role,content) VALUES('m1',$1,$2,'u','user','Old prompt')",
    [thread, run],
  );
  await new Persistence(db).migrate();
  const row = (await db.query("SELECT * FROM web_runs WHERE id=$1", [run])).rows[0];
  assert.equal(row.prompt, "Old prompt");
  assert.equal(row.kind, "request");
  assert.equal(row.meeting_session, null);
  assert.equal(row.reverted_at, null);
  const message = (await db.query("SELECT * FROM web_messages WHERE id='m1'")).rows[0];
  assert.deepEqual(message.evidence, []);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM web_canvases")).rows[0].n, 1);
});

test("migrations are additive only", () => {
  assert.doesNotMatch(
    migration.replaceAll(/DROP CONSTRAINT web_events_pkey/g, ""),
    /\b(DROP|DELETE|TRUNCATE)\b/i,
  );
});

test("re-running migrations leaves the web_events primary key untouched", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const persistence = new Persistence(db);
  await persistence.migrate();
  const key = async () =>
    (
      await db.query(
        "SELECT oid::int AS oid, conkey::text AS conkey FROM pg_constraint WHERE conname='web_events_pkey'",
      )
    ).rows;
  const first = await key();
  assert.equal(first.length, 1);
  await persistence.migrate();
  await persistence.migrate();
  assert.deepEqual(await key(), first);
});
