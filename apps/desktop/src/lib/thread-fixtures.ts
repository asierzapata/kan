/**
 * Stand-in room data for UI work. Replace with the realtime room store once
 * the transport lands — `ThreadPanel` only needs entries + participants.
 */
import type { CanvasAnchor, Participant, ThreadEntry } from "./thread";
import { PENDING_SEQ } from "./thread";
import type { RoomTransport, SendInput } from "./transport";

const day = "2026-09-19";
const at = (time: string) => `${day}T${time}+02:00`;

export const demoParticipants: Participant[] = [
  { id: "asier", name: "asier", kind: "human" },
  { id: "marta", name: "marta", kind: "human" },
  { id: "jon", name: "jon", kind: "human" },
  { id: "assistant", name: "assistant", kind: "agent", operatorId: "asier" },
  { id: "marta-agent", name: "assistant", kind: "agent", operatorId: "marta" },
  // Speakers in `conversation-script.ts`'s scripted conversations.
  { id: "juanjo", name: "Juanjo", kind: "human" },
  { id: "enric", name: "Enric", kind: "human" },
];

export const demoAnchors: CanvasAnchor[] = [
  { nodeId: "node-invalidation", label: "Invalidation" },
];

export const demoEntries: ThreadEntry[] = [
  {
    id: "t1",
    seq: 1,
    kind: "transcript",
    at: at("10:41:02"),
    authorId: "jon",
    text: "so the cache layer is the part I'm least sure about",
  },
  {
    id: "t2",
    seq: 2,
    kind: "transcript",
    at: at("10:41:30"),
    authorId: "marta",
    text: "we could invalidate on write but that's what killed us last time",
  },
  {
    id: "t3",
    seq: 3,
    kind: "transcript",
    at: at("10:42:11"),
    authorId: "jon",
    text: "what was the throughput last week anyway",
    trigger: { label: "trigger", confidence: 0.91 },
  },
  {
    id: "t4",
    seq: 4,
    kind: "transcript",
    at: at("10:43:04"),
    authorId: "marta",
    text: "check grafana metrics API",
  },
  {
    id: "m1",
    seq: 5,
    kind: "message",
    at: at("10:43:12"),
    authorId: "asier",
    text: "@assistant pull the numbers and put them next to the cache node",
    mentions: ["assistant"],
    anchors: [{ nodeId: "node-cache", label: "Cache layer" }],
  },
  {
    id: "a1",
    seq: 6,
    kind: "agent",
    at: at("10:43:18"),
    authorId: "assistant",
    model: "Claude",
    durationMs: 4200,
    text: "Throughput averaged 1.9k req/s last week, peaking Thursday. I added a chart next to Cache layer and linked it to Invalidation.",
    steps: [
      {
        id: "s1",
        tool: "queryData",
        summary: "metrics-api · throughput · 7d",
        state: "done",
      },
      {
        id: "s2",
        tool: "addNode",
        summary: "chart · 'Throughput last 7 days' · near Cache layer",
        target: { nodeId: "node-throughput", label: "Throughput last 7 days" },
        state: "done",
      },
      {
        id: "s3",
        tool: "linkNodes",
        summary: "Throughput → Invalidation",
        target: { nodeId: "node-invalidation", label: "Invalidation" },
        state: "done",
      },
      {
        id: "s4",
        tool: "readCanvas",
        summary: "resolved 'the cache node' to Cache layer",
        state: "done",
      },
      {
        id: "s5",
        tool: "editNode",
        summary: "Cache layer · appended metrics note",
        state: "done",
      },
    ],
  },
  {
    id: "g1",
    seq: 7,
    kind: "suggestion",
    at: at("10:43:40"),
    authorId: "marta-agent",
    sourceEntryId: "t2",
    sourceLabel: "from marta's comment 10:42",
    quote: "we could invalidate on write but that's what killed us last time",
    proposal: { type: "decision", label: "avoid invalidate-on-write" },
    shortcut: "⌘↵",
  },
  {
    id: "y1",
    seq: 8,
    kind: "system",
    at: at("10:44:01"),
    authorId: "asier",
    text: "asier moved 'Cold start' under OPEN QUESTIONS",
  },
];

/**
 * The fixtures behind the `RoomTransport` interface.
 *
 * Lets the thread panel render demo data without a canvas or an agent.
 */
export function createMockTransport(includeDemo = false): RoomTransport {
  const listeners = new Set<(entry: ThreadEntry) => void>();
  let nextSeq = includeDemo ? demoEntries.length + 1 : 1;

  function emit(entry: ThreadEntry) {
    for (const listener of listeners) listener(entry);
  }

  return {
    subscribe(onEntry) {
      listeners.add(onEntry);
      // The real transport replays `since=<lastSeq>` on connect, so a fresh
      // subscriber seeing the backlog is the behaviour to mimic, not a quirk.
      if (includeDemo) for (const entry of demoEntries) onEntry(entry);
      return () => listeners.delete(onEntry);
    },

    async send({ id, text, anchors, files }: SendInput) {
      emit({
        id,
        seq: nextSeq++,
        kind: "message",
        at: new Date().toISOString(),
        authorId: "asier",
        text,
        anchors: anchors.map((id) => ({ nodeId: id, label: id.replace(/^shape:/, "") })),
        attachments: files.map((file, i) => ({
          id: `local-file-${Date.now()}-${i}`,
          name: file.name,
          kind: file.type.startsWith("image/") ? "image" : ("file" as const),
          url: URL.createObjectURL(file),
          meta: `${Math.round(file.size / 1024)} KB`,
          state: "done" as const,
        })),
      });
    },

    async resolveSuggestion(entryId, accepted) {
      emit({
        id: `resolved-${entryId}`,
        seq: nextSeq++,
        kind: "system",
        at: new Date().toISOString(),
        authorId: "asier",
        text: accepted
          ? "asier accepted a suggestion"
          : "asier dismissed a suggestion",
      });
    },

    async resolveOffer(entryId, accepted) {
      emit({ id: `resolved-${entryId}`, seq: nextSeq++, kind: "system", at: new Date().toISOString(), authorId: "system", text: accepted ? "offer accepted" : "offer dismissed" });
    },

    async cancelTrigger() {},
    async retryTrigger() {},

    async claimTrigger() {
      // No classifier without a server, so nothing ever assigns us a trigger.
      return null;
    },
    setExecutorReady() {},
    snapshot() { return { connected: true, ready: false, sessionId: null, members: [], executors: [], triggers: [] }; },
  };
}

/** Re-exported so callers can mint an optimistic entry without reaching in. */
export { PENDING_SEQ };
