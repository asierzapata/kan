import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptRun } from "../src/components/thread/TranscriptRun";
import { ThreadProvider } from "../src/components/thread/thread-context";
import { toViewEntry } from "../src/lib/room-transport";
import { buildThreadRows, type TranscriptEntry } from "../src/lib/thread";
import { subscribeToOwnCaptions } from "../src/lib/room-captions";
import type OT from "@opentok/client";
import type { TranscriptInput } from "@kan/protocol";

const line: TranscriptEntry = { id: "line", seq: 1, at: "2026-09-19T12:00:00Z", kind: "transcript", authorId: "speaker", text: "Private conversation text" };

test("even a one-line transcript starts collapsed without exposing its text", () => {
  const markup = renderToStaticMarkup(createElement(ThreadProvider, {
    value: { participants: {}, currentUserId: "speaker" },
    children: createElement(TranscriptRun, { entries: [line], interimIds: new Set([line.id]) }),
  }));
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /Private conversation text/);
  assert.match(markup, /Live/);
});

test("an explicitly expanded transcript renders revised text with its live state", () => {
  const markup = renderToStaticMarkup(createElement(ThreadProvider, {
    value: { participants: { speaker: { id: "speaker", name: "Speaker", kind: "human" } }, currentUserId: "speaker" },
    children: createElement(TranscriptRun, { entries: [{ ...line, text: "Revised live text" }], interimIds: new Set([line.id]), open: true }),
  }));
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /Revised live text/);
  assert.match(markup, /data-interim="true"/);
});

test("persisted speech uses transcript rows rather than chat bubbles", () => {
  const entry = toViewEntry({ ...line, roomId: "room", kind: "message", source: "transcript", anchors: [], attachments: [] });
  assert.equal(entry?.kind, "transcript");
  const rows = buildThreadRows([entry!, { ...line, id: "next", seq: 2 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "transcript-run");
});

test("own-stream captions revise one line, finalize it, and clean up without playing audio", (t) => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({}) } as unknown as Document;
  t.after(() => { globalThis.document = original; });
  let receive!: (event: { streamId: string; caption: string; isFinal: boolean }) => void;
  let options: OT.SubscriberProperties | undefined;
  let detached = false, unsubscribed = false;
  const updates: (TranscriptInput | null)[] = [];
  const subscriber = { on: (_: string, callback: typeof receive) => { receive = callback; }, off: () => { detached = true; } };
  const session = {
    subscribe: (_stream: unknown, target: unknown, props: OT.SubscriberProperties) => {
      assert.ok(!(target && props.insertDefaultUI === false), "Vonage rejects a target element when insertDefaultUI is false");
      options = props;
      return subscriber;
    },
    unsubscribe: () => { unsubscribed = true; },
  } as unknown as OT.Session;
  const stop = subscribeToOwnCaptions(session, { streamId: "own" } as OT.Stream, (caption) => updates.push(caption), () => assert.fail("unexpected caption error"));
  assert.equal(options?.subscribeToAudio, false);
  assert.equal(options?.subscribeToVideo, false);
  assert.equal(options?.subscribeToCaptions, true);
  receive({ streamId: "other", caption: "Ignore remote stream", isFinal: true });
  receive({ streamId: "own", caption: "", isFinal: false });
  assert.equal(updates.length, 0);
  receive({ streamId: "own", caption: "Hello", isFinal: false });
  receive({ streamId: "own", caption: "Hello there", isFinal: false });
  receive({ streamId: "own", caption: "Hello there.", isFinal: true });
  assert.equal(new Set(updates.map((update) => update?.id)).size, 1);
  assert.equal(updates[2]?.isFinal, true);
  receive({ streamId: "own", caption: "Next sentence", isFinal: false });
  assert.notEqual(updates[3]?.id, updates[2]?.id);
  stop();
  assert.equal(updates.at(-1), null);
  assert.ok(detached && unsubscribed);
  const count = updates.length;
  receive({ streamId: "own", caption: "Late callback", isFinal: true });
  assert.equal(updates.length, count);
});

test("destroyed caption subscribers clear partial text and ignore late events", (t) => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({}) } as unknown as Document;
  t.after(() => { globalThis.document = original; });
  const handlers = new Map<string, (event: unknown) => void>();
  const updates: (TranscriptInput | null)[] = [];
  let errors = 0, unsubscribed = 0;
  const session = {
    subscribe: () => ({ on: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback), off: () => {} }),
    unsubscribe: () => { unsubscribed++; },
  } as unknown as OT.Session;
  const stop = subscribeToOwnCaptions(session, { streamId: "own" } as OT.Stream, (caption) => updates.push(caption), () => { errors++; });
  handlers.get("captionReceived")!({ streamId: "own", caption: "unfinished", isFinal: false });
  handlers.get("destroyed")?.({ reason: "networkDisconnected" });
  assert.equal(updates.at(-1), null);
  assert.equal(errors, 1);
  const count = updates.length;
  handlers.get("captionReceived")!({ streamId: "own", caption: "late", isFinal: true });
  assert.equal(updates.length, count);
  stop();
  assert.equal(unsubscribed, 0);
});
