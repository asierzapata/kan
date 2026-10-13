import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { Scheduler } from "../src/scheduler.ts";
import { issueTicket } from "../src/tickets.ts";
import { SECRET, client, connectMessage, fixture, quiet, testConfig, until } from "./helpers.ts";

async function setup(t: test.TestContext, verify: (user: string, session: string) => Promise<void>) {
  const f = await fixture();
  let authorized = 0;
  const app = createServer({
    config: testConfig(),
    db: f.db,
    persistence: f.persistence,
    sqlite: f.sqlite,
    flushMs: 20,
    authorize: async (claims) => {
      authorized++;
      return { role: claims.role };
    },
    assets: { put: async () => {}, get: async () => null },
  });
  const scheduler = new Scheduler({
    db: f.db,
    config: testConfig(),
    rooms: app.rooms,
    client: null,
    log: quiet,
    verifySession: verify,
  });
  const port = await app.listen(0);
  t.after(async () => {
    await app.close();
    await f.close();
  });
  const connect = async (user = "editor", role = "editor") => {
    const ticket = issueTicket(SECRET, { room: f.canvas, sub: user, sessionId: "s", role: role as any, exp: Date.now() + 30_000 });
    const c = client(`ws://127.0.0.1:${port}/sync?ticket=${ticket}`);
    t.after(() => c.ws.close());
    let closed: number | null = null;
    c.ws.on("close", (code) => (closed = code));
    await c.opened;
    c.send(connectMessage());
    await c.next("connect");
    return { c, closed: () => closed };
  };
  return { f, app, scheduler, connect, authorized: () => authorized, port };
}

test("admitted readers stay connected through recheck; revoked sessions and changed roles close", async (t) => {
  let verdict: "ok" | "revoked" = "ok";
  const s = await setup(t, async () => {
    if (verdict === "revoked") throw new Error("Session revoked");
  });
  const first = await s.connect();
  await s.scheduler.recheck();
  assert.equal(first.closed(), null, "a valid admitted reader must not be disconnected");

  await s.f.db.query("UPDATE web_memberships SET role='viewer' WHERE user_id='editor'");
  await s.scheduler.recheck();
  await until(() => first.closed() !== null);
  assert.equal(first.closed(), 1008, "role changes disconnect the old session");

  await s.f.db.query("UPDATE web_memberships SET role='editor' WHERE user_id='editor'");
  const second = await s.connect();
  verdict = "revoked";
  await s.scheduler.recheck();
  await until(() => second.closed() !== null);
  assert.equal(second.closed(), 1008, "revoked sessions disconnect");
});

test("an expired join ticket is rejected before authorization", async (t) => {
  const s = await setup(t, async () => {});
  const ticket = issueTicket(SECRET, { room: s.f.canvas, sub: "editor", sessionId: "s", role: "editor", exp: Date.now() - 1 });
  const c = client(`ws://127.0.0.1:${s.port}/sync?ticket=${ticket}`);
  await assert.rejects(c.opened, /401/);
  assert.equal(s.authorized(), 0);
});
