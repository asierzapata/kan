import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ssrDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/web/.vercel/output/functions/__server.func/_ssr",
);

const matches = readdirSync(ssrDir).filter((f) => /^diagrams-.*\.mjs$/.test(f));
assert.equal(
  matches.length,
  1,
  `expected exactly one diagrams-*.mjs in ${ssrDir}, found ${matches.length}: ${matches.join(", ")}`,
);

const { parseDiagram } = await import(pathToFileURL(join(ssrDir, matches[0])).href);
const at = { x: 0, y: 0 };

const flowchart = await parseDiagram({
  source: "flowchart LR\nA[QA Mermaid start] --> B[QA Mermaid end]",
  at,
});
assert.equal(flowchart.nodes.length, 2, "flowchart nodes");
assert.equal(flowchart.edges.length, 1, "flowchart edges");

const sequence = await parseDiagram({
  source: "sequenceDiagram\nAlice->>Bob: Hello",
  at,
});
assert.equal(sequence.nodes.length, 4, "sequence nodes");
assert.equal(sequence.edges.length, 1, "sequence edges");

console.log(
  `bundle-check ok (${matches[0]}): flowchart ${flowchart.nodes.length}n/${flowchart.edges.length}e, sequence ${sequence.nodes.length}n/${sequence.edges.length}e`,
);
