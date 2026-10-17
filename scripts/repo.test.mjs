import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, lstatSync, mkdirSync, symlinkSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("desktop edits invalidate every consumer's cached checks and builds", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kan-cache-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0");
  for (const file of files) {
    const source = join(root, file);
    if (!file || !existsSync(source) || !lstatSync(source).isFile()) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(source, join(dir, file));
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hashes = () => {
    const output = execFileSync(process.execPath, [join(root, "node_modules/turbo/bin/turbo"), "run", "build", "typecheck", "test", "--dry=json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return new Map(JSON.parse(output).tasks.map((task) => [task.taskId, task.hash]));
  };
  for (const [file, consumers] of [
    ["apps/desktop/src/lib/utils.ts", ["@kan/web#build", "@kan/web#typecheck", "@kan/server#typecheck", "@kan/server#test", "@kan/web-agent#typecheck", "@kan/web-core#test"]],
    ["apps/server/src/meeting-schema.ts", ["@kan/web-agent#typecheck", "@kan/web-core#test"]],
    ["scripts/date-nodes.test.mjs", ["@kan/desktop#test"]],
    ["packages/protocol/src/prompts.ts", ["@kan/desktop#typecheck", "@kan/web#build", "@kan/server#test"]],
  ]) {
    const before = hashes();
    appendFileSync(join(dir, file), "\n// cache invalidation regression\n");
    const after = hashes();
    for (const id of consumers) {
      assert.ok(before.has(id), `missing task ${id}`);
      assert.notEqual(after.get(id), before.get(id), `${file}: ${id} reused a stale hash`);
    }
  }
});

test("shared desktop changes enable both pre-commit scopes", () => {
  const output = execFileSync("sh", ["-c", '. .githooks/_scope.sh; printf "%s %s" "$CHECK_DESKTOP" "$CHECK_WEB"'], {
    cwd: root, input: "apps/desktop/src/nodes/draft.ts\n", encoding: "utf8",
  });
  assert.equal(output, "1 1");
});
