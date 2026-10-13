import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  getCanvasEntry,
} from "../src/lib/canvas-repository";
import { completeOnboarding } from "../src/lib/onboarding";
import { createCanvas } from "../src/lib/create-canvas";

beforeEach(() => {
  setupMockIndexedDB();
});

test("an offline canvas is created locally and never contacts the server", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the offline path must not reach the network");
  };

  try {
    const created = await createCanvas("  Sketchbook  ");
    const entry = await getCanvasEntry(created.localCanvasId);
    assert.equal(entry?.name, "Sketchbook");
    assert.equal(entry?.mode, "offline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
