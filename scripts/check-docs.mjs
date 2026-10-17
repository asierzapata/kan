import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = ["README.md", "ARCHITECTURE.md", "DEPLOY.md", "AGENTS.md", "CLAUDE.md",
  "apps/web/README.md", "apps/web-agent/README.md", "packages/web-core/README.md",
  ...readdirSync(resolve(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
let failures = 0;
for (const file of files) {
  const source = readFileSync(resolve(root, file), "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (target.startsWith("/") || !existsSync(resolve(root, dirname(file), target))) {
      console.error(`${file}: missing or non-portable link ${target}`);
      failures++;
    }
  }
}
if (failures) process.exitCode = 1;
else console.log(`Documentation links checked (${files.length} files).`);
