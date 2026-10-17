import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.ts";
import { HttpError } from "../src/http.ts";
import { verifyTicket } from "../src/tickets.ts";
import { fixture, makeRun, signUpTestUser, testConfig, SECRET } from "./helpers.ts";

const origin = "http://localhost:1430";

async function setup(t: test.TestContext) {
  const f = await fixture();
  const config = testConfig();
  const wakes: string[] = [];
  const app = createApp({
    config,
    db: f.db,
    persistence: f.persistence,
    rooms: f.rooms,
    scheduler: { wake: (canvas: string) => void wakes.push(canvas) },
    assets: { put: async () => {}, get: async () => null },
    auth: {
      async activeAuth(request) {
        const id = request.headers.get("x-test-user");
        if (!id) throw new HttpError(401, "Your session expired. Sign in to continue.");
        return { user: { id, email: `${id}@example.test`, name: id }, sessionId: "auth-session" };
      },
    },
  });
  t.after(() => f.close());
  const post = (path: string, body: unknown, user: string | null = "owner", headers: Record<string, string> = {}) =>
    app.request(`/api/web/${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, user = "owner") =>
    app.request(`/api/web/${path}`, { headers: { "x-test-user": user } });
  return { f, app, post, get, wakes };
}

test("unauthenticated requests, bad origins and wrong verbs are rejected", async (t) => {
  const s = await setup(t);
  assert.equal((await s.post("catalog", {}, null)).status, 401);
  const forged = await s.post("catalog", {}, "owner", { origin: "https://evil.test" });
  assert.equal(forged.status, 403);
  assert.equal((await s.get("workspace/create")).status, 405);
  assert.equal((await s.post("nope", { canvas: s.f.canvas })).status, 404);
  const response = await s.post("catalog", {}, null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("catalog, workspace and canvas lifecycle", async (t) => {
  const s = await setup(t);
  const empty = await (await s.post("catalog", {}, "newcomer")).json();
  assert.deepEqual(empty, { workspaces: [], canvases: [] });
  const { id: workspace } = await (await s.post("workspace/create", { name: "Studio" }, "newcomer")).json();
  const { id: canvas } = await (await s.post("canvas/create", { workspace, name: "Board" }, "newcomer")).json();
  const catalog = await (await s.post("catalog", {}, "newcomer")).json();
  assert.equal(catalog.workspaces[0].role, "owner");
  assert.equal(catalog.canvases[0].name, "Board");
  assert.equal((await s.post("canvas/create", { workspace, name: "" }, "newcomer")).status, 400);
  assert.equal((await s.post("canvas/create", { workspace: s.f.workspace, name: "No" }, "viewer")).status, 403);
  assert.equal((await s.post("canvas/rename", { canvas, name: "Renamed" }, "newcomer")).status, 200);
  assert.equal((await (await s.post("catalog", {}, "newcomer")).json()).canvases[0].name, "Renamed");
  assert.equal((await s.post("canvas/rename", { canvas, name: "Nope" }, "viewer")).status, 403);
  assert.equal((await s.post("canvas/delete", { canvas }, "newcomer")).status, 200);
  assert.deepEqual((await (await s.post("catalog", {}, "newcomer")).json()).canvases, []);
  assert.equal((await s.post("canvas/rename", { canvas, name: "Gone" }, "newcomer")).status, 404);
});

test("invitations, members, roles and revocation", async (t) => {
  const s = await setup(t);
  const created = await s.post("invitation/create", { workspace: s.f.workspace, email: "Guest@Example.test", role: "editor" });
  assert.equal(created.status, 200);
  const { url } = await created.json();
  assert.match(url, /^http:\/\/localhost:1430\/\?invite=[A-Za-z0-9_-]{43}$/);
  const token = new URL(url).searchParams.get("invite")!;
  assert.equal((await s.post("invitation/create", { workspace: s.f.workspace, email: "x@y.test", role: "editor" }, "editor")).status, 403);
  assert.equal((await s.post("invitation/create", { workspace: s.f.workspace, email: "bad", role: "editor" })).status, 400);
  assert.equal((await s.post("invitation/accept", { token }, "stranger")).status, 403);
  const accepted = await s.post("invitation/accept", { token }, "guest");
  assert.deepEqual(await accepted.json(), { workspace: s.f.workspace });
  assert.equal((await s.post("invitation/accept", { token }, "guest")).status, 200);
  const members = (await (await s.get(`members?workspace=${s.f.workspace}`)).json()).members;
  assert.ok(members.some((m: any) => m.user_id === "guest" && m.role === "editor"));
  assert.equal((await s.get(`members?workspace=${s.f.workspace}`, "editor")).status, 403);
  assert.equal((await s.post("member/role", { workspace: s.f.workspace, user: "guest", role: "viewer" })).status, 200);
  assert.equal((await s.post("member/role", { workspace: s.f.workspace, user: "owner", role: "viewer" })).status, 404);
  assert.equal((await s.post("member/role", { workspace: s.f.workspace, user: "guest", role: "owner" })).status, 400);
  assert.equal((await s.post("member/revoke", { workspace: s.f.workspace, user: "guest" })).status, 200);
  const after = (await (await s.get(`members?workspace=${s.f.workspace}`)).json()).members;
  assert.ok(!after.some((m: any) => m.user_id === "guest"));
});

test("room returns a verifiable ticket through real Better Auth sessions", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { cookie, user, auth } = await signUpTestUser(f, "viewer@example.test");
  await f.db.query("INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,'viewer')", [
    f.workspace,
    user.id,
    "viewer@example.test",
  ]);
  const app = createApp({
    config: testConfig(),
    db: f.db,
    persistence: f.persistence,
    rooms: f.rooms,
    scheduler: { wake() {} },
    assets: { put: async () => {}, get: async () => null },
    auth,
  });
  const response = await app.request(`/api/web/room?canvas=${f.canvas}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const uri = new URL(body.uri);
  assert.equal(uri.protocol, "ws:");
  assert.equal(uri.host, "localhost:1430");
  assert.equal(uri.pathname, "/sync");
  const claims = verifyTicket(SECRET, uri.searchParams.get("ticket")!);
  assert.deepEqual(
    { room: claims.room, sub: claims.sub, role: claims.role },
    { room: f.canvas, sub: user.id, role: "viewer" },
  );
  assert.ok(claims.sessionId);
  assert.equal(body.canvas.id, f.canvas);
  assert.equal((await app.request(`/api/web/room?canvas=${f.canvas}`)).status, 401);
  await f.db.query('DELETE FROM "session"');
  const stale = await createApp({
    config: testConfig(),
    db: f.db,
    persistence: f.persistence,
    rooms: f.rooms,
    scheduler: { wake() {} },
    assets: { put: async () => {}, get: async () => null },
    auth: (await signUpTestUser(f, "other@example.test")).auth,
  }).request(`/api/web/room?canvas=${f.canvas}`, { headers: { cookie } });
  assert.equal(stale.status, 401);
});

test("chat enqueues idempotently and wakes the scheduler; viewers cannot chat", async (t) => {
  const s = await setup(t);
  const input = { canvas: s.f.canvas, operation: randomUUID(), message: "Make a note", anchors: [] };
  const first = await (await s.post("chat", input, "editor")).json();
  const second = await (await s.post("chat", input, "editor")).json();
  assert.equal(first.id, second.id);
  assert.deepEqual(s.wakes, [s.f.canvas, s.f.canvas]);
  assert.equal((await s.post("chat", { ...input, operation: randomUUID() }, "viewer")).status, 403);
  assert.equal(s.wakes.length, 2);
  const history = await (await s.get(`history?canvas=${s.f.canvas}`, "viewer")).json();
  assert.equal(history.runs.length, 1);
  assert.equal(history.messages[0].content, "Make a note");
});

test("cancelling a queued run wakes the scheduler", async (t) => {
  const s = await setup(t);
  const run = await (await s.post("chat", { canvas: s.f.canvas, operation: randomUUID(), message: "Cancel me" }, "editor")).json();
  s.wakes.length = 0;
  assert.equal((await s.post("cancel", { canvas: s.f.canvas, run: run.id }, "editor")).status, 200);
  assert.deepEqual(s.wakes, [s.f.canvas]);
  const row = (await s.f.db.query("SELECT status FROM web_runs WHERE id=$1", [run.id])).rows[0];
  assert.equal(row.status, "cancelled");
});

test("internal requires the service secret and only supports tool and arm-recovery", async (t) => {
  const s = await setup(t);
  const raw = (headers: Record<string, string>, body: unknown = { action: "tool" }, method = "POST") =>
    s.app.request("/api/web/internal", { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
  assert.equal((await raw({})).status, 401);
  assert.equal((await raw({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await raw({ authorization: `Bearer ${SECRET}` }, {}, "GET")).status, 401);
  const auth = { authorization: `Bearer ${SECRET}` };
  for (const action of ["authorize", "acquire", "commit", "receipt", "replay", "dispatch", "pending-canvases"])
    assert.equal((await raw(auth, { action })).status, 400, action);
  assert.equal((await raw(auth, { action: "arm-recovery", run: randomUUID() })).status, 403);
});

test("internal tool reads and writes the canvas through applyTool", async (t) => {
  const s = await setup(t);
  const run = await makeRun(s.f, "running");
  const session = `session-${run}`;
  const auth = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
  const tool = (body: Record<string, unknown>) =>
    s.app.request("/api/web/internal", { method: "POST", headers: auth, body: JSON.stringify({ action: "tool", session, ...body }) });
  const read = await tool({ name: "getCanvas", input: {}, callId: "read" });
  assert.equal(read.status, 200);
  const canvas = await read.json();
  assert.equal(typeof canvas.revision, "number");
  const draft = { draft: { type: "markdown", title: "Agent", body: "Written through applyTool" } };
  const stale = await tool({ name: "addNode", input: draft, callId: "w0" });
  assert.equal(stale.status, 409);
  const written = await tool({ name: "addNode", input: draft, callId: "w1", expectedRevision: canvas.revision });
  assert.equal(written.status, 200);
  const result = await written.json();
  assert.ok(result.revision > canvas.revision);
  const handle = await s.f.open();
  assert.ok(handle.storage.getSnapshot().documents.some((d) => d.state.id === `shape:${run}:w1`));
  assert.ok((await s.f.persistence.receipt(s.f.canvas, `${run}:w1`, { name: "addNode", input: draft, actor: { user: "editor", run, session } })));
  const unknown = await s.app.request("/api/web/internal", {
    method: "POST", headers: auth, body: JSON.stringify({ action: "tool", session: "missing", name: "getCanvas", callId: "x" }),
  });
  assert.equal(unknown.status, 403);
});
