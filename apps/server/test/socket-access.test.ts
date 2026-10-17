import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { Scheduler } from "../src/scheduler.ts";
import { issueTicket } from "../src/tickets.ts";
import { SECRET, client, connectMessage, fixture, quiet, signUpTestUser, testConfig, until } from "./helpers.ts";

async function setup(t: test.TestContext, verify: (user: string, session: string) => Promise<void>) {
  const f = await fixture();
  let authorized = 0;
  const app = createServer({
    config: testConfig(),
    db: f.db,
    kysely: f.kysely,
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

test("recheck kicks a socket once its real Better Auth session row is deleted", async (t) => {
  const s = await setup(t, async () => {});
  const { user, auth, cookie } = await signUpTestUser(s.f, "socket@example.test");
  await s.f.db.query("INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,'editor')", [
    s.f.workspace,
    user.id,
    "socket@example.test",
  ]);
  const { sessionId } = await auth.activeAuth(new Request("http://localhost:1430/", { headers: { cookie } }));
  const scheduler = new Scheduler({
    db: s.f.db,
    config: testConfig(),
    rooms: s.app.rooms,
    client: null,
    log: quiet,
    verifySession: (u, sid) => auth.assertActiveSession(u, sid),
  });
  const ticket = issueTicket(SECRET, { room: s.f.canvas, sub: user.id, sessionId, role: "editor", exp: Date.now() + 30_000 });
  const c = client(`ws://127.0.0.1:${s.port}/sync?ticket=${ticket}`);
  t.after(() => c.ws.close());
  let closed: number | null = null;
  c.ws.on("close", (code) => (closed = code));
  await c.opened;
  c.send(connectMessage());
  await c.next("connect");
  await scheduler.recheck();
  assert.equal(closed, null);
  await s.f.db.query('DELETE FROM "session" WHERE id=$1', [sessionId]);
  const fresh = new Scheduler({
    db: s.f.db,
    config: testConfig(),
    rooms: s.app.rooms,
    client: null,
    log: quiet,
    verifySession: (await signUpTestUser(s.f, "fresh@example.test")).auth.assertActiveSession,
  });
  await fresh.recheck();
  await until(() => closed !== null);
  assert.equal(closed, 1008);
});
