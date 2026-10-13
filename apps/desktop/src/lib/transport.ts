/**
 * The seam between the thread UI and wherever entries actually come from.
 *
 * `ThreadPanel` is transport agnostic (entries in, callbacks out). The local
 * transport and the fixtures implement `RoomTransport`, and the panel cannot
 * tell them apart.
 *
 * The wire type lives in `@kan/protocol`. Nothing
 * here may widen it — `toViewEntry` is the only place the two vocabularies
 * meet.
 */
import type { AssistantEagerness, Entry, ExecutorPresence, Lease, LiveTranscript, NodeDraft, Room, TranscriptInput, User } from "@kan/protocol";

import type { AgentStep, CanvasAnchor, ThreadEntry } from "./thread";

export interface SendInput {
  /**
   * Client-minted id. The echo carries it back so the sender can match its
   * optimistic copy.
   */
  id: string;
  text: string;
  /** Shape ids of the current canvas selection. */
  anchors: string[];
  files: File[];
  source?: "typed" | "transcript";
  replyToEntryId?: string;
}

export interface RoomSnapshot {
  connected: boolean;
  ready: boolean;
  sessionId: string | null;
  room?: Room;
  members: User[];
  executors: ExecutorPresence[];
  triggers: import("@kan/protocol").Trigger[];
  error?: string;
  transcripts?: LiveTranscript[];
}

export interface RoomTransport {
  /** Fires on every authoritative websocket event and ready snapshot. */
  subscribe(onEntry: (entry: ThreadEntry) => void, onSnapshot?: (snapshot: RoomSnapshot) => void): () => void;
  send(input: SendInput): Promise<void>;
  sendTranscript?(input: TranscriptInput | null): void;
  resolveSuggestion(entryId: string, accepted: boolean): Promise<void>;
  resolveOffer(entryId: string, accepted: boolean): Promise<void>;
  cancelTrigger(triggerId: string): Promise<void>;
  retryTrigger(triggerId: string): Promise<void>;
  claimTrigger(triggerId: string): Promise<Lease | null>;
  setExecutorReady(ready: boolean, agentId: string, scope: "own" | "room" | "manual", background: boolean): void;
  /** Local canvases pace themselves. */
  setAssistantEagerness?(value: AssistantEagerness): void;
  snapshot(): RoomSnapshot;
}

/* ----------------------------------------------------------- wire -> view */

/** Anchors arrive as bare shape ids; labels are resolved from the canvas. */
function toAnchors(shapeIds: string[]): CanvasAnchor[] {
  return shapeIds.map((id) => ({ nodeId: id, label: id.replace(/^shape:/, "") }));
}

/** Agent steps are bounded JSON on the wire, so narrow defensively. */
function toSteps(steps: unknown[]): AgentStep[] {
  return steps.flatMap((raw, i) => {
    if (typeof raw !== "object" || raw === null) return [];
    const step = raw as Record<string, unknown>;
    return [
      {
        id: typeof step.id === "string" ? step.id : `step-${i}`,
        tool: typeof step.tool === "string" ? step.tool : "tool",
        summary: typeof step.summary === "string" ? step.summary : "",
        state:
          step.state === "running" || step.state === "pending" || step.state === "error"
            ? step.state
            : "done",
        durationMs: typeof step.durationMs === "number" ? step.durationMs : undefined,
        error: typeof step.error === "string" ? step.error : undefined,
      },
    ];
  });
}

function draftLabel(draft: NodeDraft): string {
  return draft.type === "concept" ? draft.label : draft.type === "logo" ? draft.name || draft.domain : draft.title;
}

/**
 * Maps one wire entry onto the row model the thread renders.
 *
 * Voice has no wire kind at all yet, so `transcript` view entries only ever
 * come from fixtures — everything else the room can say has a case here.
 */
export function toViewEntry(entry: Entry): ThreadEntry | null {
  const base = { id: entry.id, seq: entry.seq, at: entry.at };

  switch (entry.kind) {
    case "message":
      if (entry.source === "transcript") return { ...base, kind: "transcript", authorId: entry.authorId, text: entry.text };
      return {
        ...base,
        kind: "message",
        authorId: entry.authorId,
        text: entry.text,
        anchors: toAnchors(entry.anchors),
        source: entry.source,
        replyToEntryId: entry.replyToEntryId,
      };

    case "system":
      return { ...base, kind: "system", authorId: entry.authorId, text: entry.text };

    case "agent_turn":
      return {
        ...base,
        kind: "agent",
        authorId: entry.agentId,
        text: entry.text,
        traceId: entry.runId,
        steps: toSteps(entry.steps),
        sources: entry.sources,
        status: entry.status,
        hidden: entry.hidden,
      };

    case "suggestion":
      return {
        ...base,
        kind: "suggestion",
        authorId: entry.runId,
        sourceLabel: `from trigger ${entry.triggerId.slice(0, 8)}`,
        quote: entry.text ?? draftLabel(entry.draft),
        proposal: { type: entry.draft.type, label: draftLabel(entry.draft) },
        text: entry.text,
        draft: entry.draft,
        sources: entry.sources,
        targetShapeId: entry.targetShapeId,
        status: entry.status,
        resolvedBy: entry.resolvedBy,
      };

    case "trigger":
      return {
        ...base,
        kind: "trigger",
        authorId: entry.trigger.requestedBy,
        triggerId: entry.trigger.id,
        requestedBy: entry.trigger.requestedBy,
        reason: entry.trigger.reason,
        mode: entry.trigger.mode,
        status: entry.trigger.status,
        anchors: entry.trigger.anchors,
        assigneeSessionId: entry.trigger.assigneeSessionId,
        attempt: entry.trigger.attempt,
      };

    case "offer":
      return {
        ...base,
        kind: "offer",
        authorId: entry.runId,
        triggerId: entry.triggerId,
        runId: entry.runId,
        title: entry.title,
        request: entry.request,
        text: entry.text,
        sources: entry.sources,
        status: entry.status,
        resolvedBy: entry.resolvedBy,
        resultTriggerId: entry.resultTriggerId,
      };
  }
}

export function toViewEntries(entries: Entry[]): ThreadEntry[] {
  return entries.flatMap((entry) => {
    const view = toViewEntry(entry);
    return view ? [view] : [];
  });
}
