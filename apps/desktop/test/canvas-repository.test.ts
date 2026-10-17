import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  createOfflineCanvas,
  getCanvasEntry,
  listLocalCanvases,
  touchCanvas,
  deleteCanvasEntry,
} from "../src/lib/canvas-repository";

beforeEach(() => {
  setupMockIndexedDB();
});

test("canvas catalog lifecycle and ordering", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-09-19T12:00:00Z"),
  });
  clearMockIndexedDB();

  const c1 = await createOfflineCanvas({ name: "Canvas 1" });
  assert.equal(c1.name, "Canvas 1");
  assert.equal(c1.mode, "offline");
  assert.equal(c1.localPersistenceKey, `kan-room-${c1.id}`);

  t.mock.timers.tick(1000);
  const c2 = await createOfflineCanvas({ name: "Canvas 2" });
  assert.equal(c2.name, "Canvas 2");

  const list = await listLocalCanvases();
  assert.equal(list.length, 2);
  // Canvas 2 was created later, so it appears first
  assert.equal(list[0].id, c2.id);
  assert.equal(list[1].id, c1.id);

  // Touching canvas 1 moves it to the front
  t.mock.timers.tick(1000);
  await touchCanvas(c1.id);
  const updatedList = await listLocalCanvases();
  assert.equal(updatedList[0].id, c1.id);
});

test("delete canvas entry removes from catalog", async () => {
  clearMockIndexedDB();
  const c = await createOfflineCanvas({ name: "To Delete" });
  assert.ok(await getCanvasEntry(c.id));

  await deleteCanvasEntry(c.id);
  assert.equal(await getCanvasEntry(c.id), null);
});
