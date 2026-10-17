// Real browser -> Better Auth -> HTTP/WS -> isolated PGlite. No paid agent calls.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "kan-smoke-"));
const session = `kan-smoke-${process.pid}`;
const children = [];
let logs = "";
const env = {
  ...process.env, KAN_ENV: "development", KAN_DATA_DIR: dir, PORT: "8787",
  KAN_PUBLIC_URL: "http://localhost:1430", DATABASE_URL: "", S3_BUCKET: "",
  EVE_URL: "", KAN_SERVICE_SECRET: "smoke-local-service-secret",
  BETTER_AUTH_SECRET: "smoke-local-auth-secret-01234567890123456789",
};
const browser = async (...args) => (await run(process.execPath,
  [join(root, "node_modules/agent-browser/bin/agent-browser.js"), "--session", session, ...args],
  { cwd: root, timeout: 45000, maxBuffer: 1024 * 1024 })).stdout;
async function ready(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (children.some((child) => child.exitCode !== null)) throw Error("Smoke service exited before readiness");
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(500);
  }
  throw Error(`Readiness timed out: ${url}`);
}
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk).slice(-30000); });
  return child;
}
try {
  // Refuse occupied ports; never reuse or stop another developer's app.
  const { createServer } = await import("node:net");
  for (const port of [8787, 1430]) {
    const probe = createServer();
    await new Promise((resolve, reject) => probe.once("error", reject).listen(port, resolve));
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
  start(["--import", "tsx", "apps/server/src/main.ts"]);
  start(["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts", "apps/web"]);
  await Promise.all([ready("http://localhost:8787/healthz"), ready("http://localhost:1430/")]);
  console.log("Smoke server and web ready.");
  await browser("open", "http://localhost:1430");
  await browser("wait", "#signin-email");
  await browser("find", "role", "button", "click", "--name", "Create account");
  await browser("fill", "#signin-name", "Smoke User");
  await browser("fill", "#signin-email", `smoke-${process.pid}@example.test`);
  await browser("fill", "#signin-password", "smoke-local-only-password");
  await browser("click", "button[type=submit]");
  await browser("wait", "--text", "New workspace");
  await browser("find", "role", "button", "click", "--name", "New workspace");
  await browser("fill", "#action-name", "Smoke workspace");
  await browser("find", "role", "button", "click", "--name", "Create workspace");
  await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
  await browser("wait", "--text", "New canvas");
  await browser("find", "role", "button", "click", "--name", "New canvas");
  await browser("fill", "#action-name", "Smoke canvas");
  await browser("find", "role", "button", "click", "--name", "Create canvas");
  await browser("wait", "--fn", "window.__kanWeb && document.querySelector('.canvas-sync')?.textContent.includes('Connected')");
  await browser("eval", "window.__kanWeb.tools.addNode({draft:{type:'markdown',title:'Smoke',body:'Fresh local setup'}})");
  // Check the server's actual sync store for a shape, rather than matching an
  // unrelated page/document initialization flush or sleeping an arbitrary time.
  const sqlite = new DatabaseSync(join(dir, "rooms.sqlite"), { readOnly: true });
  try {
    const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'room_%_documents'").get();
    assert.match(table?.name ?? "", /^room_[a-f0-9_]+_documents$/);
    const count = sqlite.prepare(`SELECT count(*) AS count FROM "${table.name}" WHERE id LIKE 'shape:%'`);
    for (let attempt = 0; count.get().count !== 1; attempt++) {
      if (attempt === 60) throw Error("Canvas shape was not persisted to the sync store");
      await delay(250);
    }
  } finally { sqlite.close(); }
  await browser("reload");
  await browser("wait", "--fn", "window.__kanWeb?.tools.getCanvas().nodes.length===1 && document.querySelector('.canvas-sync')?.textContent.includes('Connected')");
  const counts = await browser("eval", "JSON.stringify(window.__kanWeb.tools.getCanvas().counts)");
  assert.match(counts, /markdown/);
  const screenshot = process.env.KAN_SMOKE_SCREENSHOT || join(tmpdir(), "kan-smoke.png");
  await browser("screenshot", screenshot);
  assert.ok((await readFile(screenshot)).length > 1000);
  const errors = await browser("errors");
  assert.equal(errors.trim(), "", `Uncaught browser errors: ${errors}`);
  console.log(`PASS: signup, workspace, canvas, synced edit and persistence after reload. Screenshot: ${screenshot}`);
} catch (error) {
  console.error(logs);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser("close").catch(() => {});
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }));
  await rm(dir, { recursive: true, force: true });
}
