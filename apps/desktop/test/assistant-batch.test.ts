import assert from "node:assert/strict";
import { test } from "node:test";
import { toRichText, type TLShape, type TLShapeId, type TLShapePartial } from "@tldraw/tlschema";
import type { Editor } from "tldraw";
import type { Mutation, NodeDraft } from "@kan/protocol";
import { toViewEntry } from "../src/lib/transport";
const { applyAssistantOperations }: typeof import("../src/lib/assistant-canvas") = await import(process.env.KAN_GALTEA_CANVAS_MODULE ?? "../src/lib/assistant-canvas");

function fixture() {
  const initial = [
    { id: "shape:launch", typeName: "shape", type: "geo", parentId: "page:page", x: 100, y: 100, rotation: 0, isLocked: false, meta: { human: "keep" }, props: { geo: "rectangle", w: 300, h: 140, color: "red", richText: toRichText("Launch: awaiting approval") } },
    { id: "shape:notes", typeName: "shape", type: "kan-node", parentId: "page:page", x: 500, y: 100, rotation: 0, isLocked: false, meta: { human: "keep" }, props: { w: 340, h: 240, draft: { type: "markdown", title: "Legal review", body: "Legal approval is pending. Budget ceiling: EUR 5000." } } },
  ] as TLShape[];
  const shapes = new Map(initial.map(shape => [shape.id, structuredClone(shape)]));
  const writes: TLShapePartial[][] = [];
  const editor = {
    getSnapshot: () => ({ document: { store: Object.fromEntries(shapes) } }),
    getCurrentPageId: () => "page:page",
    getViewportPageBounds: () => ({ x: 0, y: 0 }),
    getShapePageBounds: (shape: TLShape) => {
      const saved = shapes.get(shape.id)!;
      const { w, h } = saved.props as { w: number; h: number };
      return { x: saved.x, y: saved.y, w, h, center: { x: saved.x + w / 2, y: saved.y + h / 2 } };
    },
    run: (fn: () => void) => fn(),
    createShapes: (values: TLShapePartial[]) => { for (const value of values) shapes.set(value.id, value as TLShape); },
    updateShapes: (values: TLShapePartial[]) => {
      writes.push(values);
      for (const value of values) {
        const prior = shapes.get(value.id)!;
        shapes.set(value.id, { ...prior, ...value, props: { ...prior.props, ...value.props } } as TLShape);
      }
    },
    createBindings: () => {},
  } as unknown as Editor;
  return { editor, shapes, writes, initial };
}

for (const draft of [
  { type: "decision", title: "Launch decision", bullets: ["Await approval"] },
  { type: "concept", label: "Launch" },
] satisfies NodeDraft[]) {
  test(`adding a shared ${draft.type} does not use the rich-node converter`, () => {
    const { editor, shapes } = fixture();
    applyAssistantOperations(editor, [{ type: "add", shapeId: "shape:new", draft }], { entryId: "shared-add" });
    const shape = shapes.get("shape:new" as TLShapeId)!;
    assert.equal(shape.type, "kan-node");
    assert.deepEqual((shape.props as { draft: unknown }).draft, draft);
  });
}

for (const position of [{}, { x: 25, y: 45 }]) {
  test(`a logo overlaps its near shape unless coordinates are explicit: ${JSON.stringify(position)}`, () => {
    const { editor, shapes } = fixture();
    applyAssistantOperations(editor, [{ type: "add", shapeId: "shape:logo", nearShapeId: "shape:launch", draft: { type: "logo", domain: "example.com" }, ...position }], { entryId: "logo-add" });
    const shape = shapes.get("shape:logo" as TLShapeId)!;
    assert.equal(shape.type, "kan-logo");
    assert.equal(shape.x, position.x ?? 320);
    assert.equal(shape.y, position.y ?? 20);
  });
}

for (const name of ["Example", undefined, ""]) {
  test(`logo suggestions use a name or domain as their label: ${JSON.stringify(name)}`, () => {
    const entry = toViewEntry({ id: "suggestion", seq: 1, at: "2026-09-20T12:00:00Z", roomId: "room", kind: "suggestion", triggerId: "trigger", runId: "run", draft: { type: "logo", domain: "example.com", name }, status: "open", shapeId: null });
    assert.equal(entry?.kind, "suggestion");
    if (entry?.kind !== "suggestion") throw new Error("Expected a suggestion");
    assert.equal(entry.proposal.label, name || "example.com");
    assert.equal(entry.quote, name || "example.com");
  });
}

const style: Mutation = { type: "style", shapeId: "shape:launch", color: "blue" };
const label: Mutation = { type: "label", shapeId: "shape:launch", text: "Launch: awaiting approval - PM review complete" };
const arrange: Mutation = { type: "arrange", shapeIds: ["shape:notes", "shape:launch"], layout: "column" };

for (const operations of [[style, label], [label, style], [style, label, arrange], [arrange, label, style], [label, arrange, style], [style, arrange, label]]) {
  test(`compound assistant batch preserves all edits: ${operations.map(op => op.type).join(" then ")}`, () => {
    const { editor, shapes, writes, initial } = fixture();
    applyAssistantOperations(editor, operations, { entryId: "galtea-regression" });
    const launch = shapes.get("shape:launch" as TLShapeId)!;
    assert.equal((launch.props as { color: string }).color, "blue");
    assert.deepEqual((launch.props as { richText: unknown }).richText, toRichText("Launch: awaiting approval - PM review complete"));
    assert.equal(launch.meta.human, "keep");
    assert.equal(shapes.size, 2);
    if (operations.includes(arrange)) assert.ok(launch.y > shapes.get("shape:notes" as TLShapeId)!.y);
    else assert.deepEqual(shapes.get("shape:notes" as TLShapeId), initial[1]);
    assert.equal(writes[0].filter(shape => shape.id === launch.id).length, 1);
  });
}

test("an updated shared card keeps its new content when arranged in the same batch", () => {
  const { editor, shapes } = fixture();
  const draft = { type: "markdown" as const, title: "Legal review", body: "Approval pending; review scheduled." };
  applyAssistantOperations(editor, [{ type: "update", shapeId: "shape:notes", draft }, arrange], { entryId: "galtea-card" });
  assert.deepEqual((shapes.get("shape:notes" as TLShapeId)!.props as { draft: unknown }).draft, draft);
});

test("a later invalid operation does not apply an earlier valid change", () => {
  const { editor, shapes, initial, writes } = fixture();
  assert.throws(() => applyAssistantOperations(editor, [style, { type: "label", shapeId: "shape:missing", text: "No" }], { entryId: "invalid" }), /no longer exists/);
  assert.deepEqual([...shapes.values()], initial);
  assert.equal(writes.length, 0);
});
