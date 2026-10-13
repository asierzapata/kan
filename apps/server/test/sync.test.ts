import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { issueTicket, type TicketClaims } from "../src/tickets.ts";
import { SECRET, client, connectMessage, fixture, testConfig } from "./helpers.ts";

async function setup(t: test.TestContext, role = "editor") {
  const f = await fixture();
  const app = createServer({
    config: testConfig(),
    db: f.db,
    kysely: f.kysely,
    persistence: f.persistence,
    sqlite: f.sqlite,
    flushMs: 20,
    authorize: async () => ({ role }),
    assets: { put: async () => {}, get: async () => null },
  });
  const port = await app.listen(0);
  t.after(async () => {
    await app.close();
    await f.close();
  });
  const ticket = (extra: Partial<TicketClaims> = {}, secret = SECRET) =>
    issueTicket(secret, { room: f.canvas, sub: "editor", sessionId: "s", role: "editor", exp: Date.now() + 30_000, ...extra });
  const url = (ticketValue: string, path = "/sync") => `ws://127.0.0.1:${port}${path}?ticket=${ticketValue}`;
  return { f, app, port, ticket, url };
}

const denied = async (url: string, headers?: Record<string, string>) => {
  const { WebSocket } = await import("ws");
  return new Promise<string>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    ws.on("error", () => resolve("error"));
    ws.on("open", () => resolve("open"));
  });
};

test("a valid ticket connects and receives the tldraw connect response", async (t) => {
  const s = await setup(t);
  const c = client(s.url(s.ticket()));
  t.after(() => c.ws.close());
  await c.opened;
  c.send(connectMessage());
  const message = await c.next("connect");
  assert.equal(message.isReadonly, false);
});

test("viewer tickets connect read-only", async (t) => {
  const s = await setup(t, "viewer");
  const c = client(s.url(s.ticket({ role: "viewer" })));
  t.after(() => c.ws.close());
  await c.opened;
  c.send(connectMessage());
  assert.equal((await c.next("connect")).isReadonly, true);
});

test("expired, forged, wrong-origin, wrong-path and role-mismatched upgrades get 401", async (t) => {
  const s = await setup(t);
  assert.equal(await denied(s.url(s.ticket({ exp: Date.now() - 1 }))), "401");
  assert.equal(await denied(s.url(s.ticket({}, "another-secret-another"))), "401");
  assert.equal(await denied(s.url(s.ticket()), { origin: "https://evil.test" }), "401");
  assert.equal(await denied(s.url(s.ticket(), "/other")), "401");
  assert.equal(await denied(s.url(s.ticket({ role: "owner" }))), "401");
  assert.equal(await denied(s.url(s.ticket()), { origin: "http://localhost:1430" }), "open");
});
