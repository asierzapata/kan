import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { fixture, signUpTestUser, testConfig } from "./helpers.ts";

const request = (cookie?: string) =>
  new Request("http://localhost:1430/api/web/catalog", { headers: cookie ? { cookie } : {} });

test("a signed-up user's cookie resolves to an active session; forged cookies do not", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { cookie, user, auth } = await signUpTestUser(f, "alice@example.test", "Alice");
  assert.match(cookie, /better-auth\.session_token=/);
  const active = await auth.activeAuth(request(cookie));
  assert.equal(active.user.id, user.id);
  assert.equal(active.user.email, "alice@example.test");
  assert.equal(active.user.name, "Alice");
  assert.ok(active.sessionId);
  await assert.rejects(auth.activeAuth(request()), (e: any) => e.status === 401);
  await assert.rejects(
    auth.activeAuth(request("better-auth.session_token=forged.value")),
    (e: any) => e.status === 401,
  );
});

test("assertActiveSession follows the session row", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { cookie, user, auth } = await signUpTestUser(f, "bob@example.test");
  const { sessionId } = await auth.activeAuth(request(cookie));
  await auth.assertActiveSession(user.id, sessionId);
  await assert.rejects(auth.assertActiveSession("someone-else", sessionId), (e: any) => e.status === 401);
  await assert.rejects(auth.assertActiveSession(user.id, "nope"), (e: any) => e.status === 401);
  await f.db.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [sessionId]);
  // Cached for up to 30 s; a fresh service instance sees the expiry immediately.
  const fresh = (await signUpTestUser(f, "carol@example.test")).auth;
  await assert.rejects(fresh.assertActiveSession(user.id, sessionId), (e: any) => e.status === 401);
  await f.db.query('DELETE FROM "session"');
  await assert.rejects(fresh.assertActiveSession(user.id, sessionId), (e: any) => e.status === 401);
});

test("the Better Auth handler is mounted under /api/auth with email sign-in", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { auth } = await signUpTestUser(f, "dana@example.test");
  const app = createApp({
    config: testConfig(),
    db: f.db,
    persistence: f.persistence,
    rooms: f.rooms,
    scheduler: { wake() {} },
    assets: { put: async () => {}, get: async () => null },
    auth,
  });
  const origin = "http://localhost:1430";
  const signIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: "dana@example.test", password: "correct horse battery" }),
  });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = await app.request("/api/auth/get-session", { headers: { cookie } });
  assert.equal((await me.json()).user.email, "dana@example.test");
  const wrong = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: "dana@example.test", password: "not the password" }),
  });
  assert.equal(wrong.status, 401);
  const crossOrigin = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin: "https://evil.test", "content-type": "application/json", cookie },
    body: JSON.stringify({ email: "dana@example.test", password: "correct horse battery" }),
  });
  assert.equal(crossOrigin.status, 403);
});
