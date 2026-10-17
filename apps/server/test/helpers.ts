import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { memoryDatabase } from "../src/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createAuth } from "../src/auth.ts";
import { RoomManager } from "../src/rooms.ts";
import { planTool } from "../src/planner.ts";
import { schema } from "../src/schema.ts";

export const SECRET = "test-secret-test-secret";

export const testConfig = (extra: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({
    KAN_SERVICE_SECRET: SECRET,
    BETTER_AUTH_SECRET: "b".repeat(32),
    KAN_WEB_DIST: "/nonexistent",
    ...extra,
  });

export const quiet = { error() {}, warn() {}, info() {} };

export function manager(
  db: any,
  persistence: any,
  opts: { flushMs?: number; idleMs?: number; sqlite?: DatabaseSync } = {},
) {
  const sqlite = opts.sqlite ?? new DatabaseSync(":memory:");
  const rooms = new RoomManager({
    db,
    persistence,
    sqlite,
    schema,
    flushMs: opts.flushMs ?? 20,
    idleMs: opts.idleMs ?? 50,
    log: quiet,
  });
  return { rooms, sqlite };
}

export async function seedWorkspace(db: any, workspace: string, roles = ["owner", "editor", "viewer"]) {
  await db.query("INSERT INTO web_workspaces(id,name) VALUES($1,$2)", [workspace, "Synthetic"]);
  for (const role of roles)
    await db.query(
      "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,$4)",
      [workspace, role, `${role}@example.test`, role],
    );
}

export async function fixture(opts: { flushMs?: number; idleMs?: number } = {}) {
  const database = await memoryDatabase();
  const { db, kysely, persistence } = database;
  const workspace = randomUUID();
  const canvas = randomUUID();
  await seedWorkspace(db, workspace);
  await db.query("INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,$3)", [
    canvas,
    workspace,
    "Fixture",
  ]);
  const thread = randomUUID();
  await db.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,'Fixture thread')", [thread, canvas]);
  const { rooms, sqlite } = manager(db, persistence, opts);
  return {
    db,
    kysely,
    persistence,
    sqlite,
    rooms,
    workspace,
    canvas,
    thread,
    open: () => rooms.open(canvas),
    async close() {
      await rooms.close();
      sqlite.close();
      await database.close();
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function makeRun(f: Fixture, status = "complete", user = "editor") {
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,status,session_id) VALUES($1,$2,$3,$4,'hash','Synthetic',$5,$6)",
    [id, f.thread, user, randomUUID(), status, `session-${id}`],
  );
  return id;
}

export const agentCommand = (run: string, callId: string, name: string, input: unknown, extra = {}) => ({
  name,
  input,
  operation: `${run}:${callId}`,
  run,
  session: `session-${run}`,
  user: "editor",
  ...extra,
});

export const command = (name: string, input: unknown, extra: Record<string, unknown> = {}): any => ({
  name,
  input,
  operation: randomUUID(),
  run: randomUUID(),
  user: "editor",
  ...extra,
});

export async function ensureRun(f: Fixture, c: any) {
  const existing = (await f.db.query("SELECT id FROM web_runs WHERE id=$1", [c.run])).rows[0];
  if (existing) return;
  await f.db.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,status,session_id) VALUES($1,$2,$3,$4,'hash','Synthetic','running',$5)",
    [c.run, f.thread, c.user, randomUUID(), `session-${c.run}`],
  );
}

export async function apply(f: Fixture, c: any) {
  await ensureRun(f, c);
  const handle = await f.open();
  const full = { ...c, session: c.session ?? `session-${c.run}` };
  const plan = planTool(handle.room, schema, full);
  await f.rooms.applyTool(f.canvas, full);
  return plan;
}

export const shapes = (handle: { room: { getCurrentSnapshot(): { documents: { state: any }[] } } }) =>
  handle.room.getCurrentSnapshot().documents.map((d) => d.state).filter((d) => d.typeName === "shape");

export const liveIds = (handle: any): string[] =>
  handle.room.getCurrentSnapshot().documents.map((d: any) => d.state.id);

export async function until<T>(fn: () => Promise<T | false | undefined> | T | false | undefined, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function client(url: string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "data") messages.push(...message.data);
    else messages.push(message);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  return {
    ws,
    messages,
    opened,
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    next: (type: string, from = 0) =>
      until(() => messages.slice(from).find((m) => m.type === type)),
  };
}

export const connectMessage = () => ({
  type: "connect",
  connectRequestId: randomUUID(),
  lastServerClock: 0,
  protocolVersion: 8,
  schema: schema.serialize(),
});

export const assetRecord = (id: string, src: string) => ({
  id: `asset:${id}`,
  typeName: "asset",
  type: "image",
  props: { name: "x.png", src, w: 10, h: 10, mimeType: "image/png", isAnimated: false },
  meta: {},
});

export async function signUpTestUser(
  f: { kysely: any },
  email: string,
  name = email.split("@")[0],
  config = testConfig(),
) {
  const auth = createAuth(config, f.kysely);
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: "correct horse battery", name },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { cookie, user: response.user, auth };
}
