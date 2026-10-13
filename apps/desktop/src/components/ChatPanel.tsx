import * as React from "react";

import { AssistantMenu, ThreadPanel } from "./thread";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { ASSISTANT_EAGERNESS, DEFAULT_EAGERNESS, type AssistantEagerness } from "@kan/protocol";
import { fromChimeIn, toChimeIn, type AssistantScope, type ChimeIn } from "@/lib/assistant-settings";

import { useCanvas } from "./canvas-context";
import { assistantCanvasRecords, applyAssistantOperations } from "@/lib/assistant-canvas";
import type { AgentEntry, AgentStep, OfferEntry, SuggestionEntry, ThreadEntry, TriggerEntry } from "@/lib/thread";
import { PENDING_SEQ } from "@/lib/thread";
import type { RoomTransport } from "@/lib/transport";

import { createLocalTransport, type LocalTransport } from "@/lib/local-transport";
import { useAgent } from "./agent-context";
import { runAssistantTurn, startLeaseExecution, type LeaseExecution, type LeasePhase } from "@/lib/assistant-controller";

import { getInstallationProfile } from "@/lib/installation-profile";
import { type AiModelSelection } from "@/components/ui/ai-model-select";
import { useQaSource } from "@/lib/qa-source";

const DEFAULT_USER = "You";

interface AssistantSettings {
  scope: AssistantScope;
  background: boolean;
  eagerness: AssistantEagerness;
}

const ASSISTANT_DEFAULTS: AssistantSettings = { scope: "own", background: false, eagerness: DEFAULT_EAGERNESS };

function readAssistantSettings(roomId: string | undefined): AssistantSettings {
  const saved = roomId ? localStorage.getItem(`kan-assistant:${roomId}`) : null;
  if (!saved) return ASSISTANT_DEFAULTS;
  try {
    const value = JSON.parse(saved) as Partial<AssistantSettings>;
    return {
      scope: value.scope === "own" || value.scope === "room" || value.scope === "manual" ? value.scope : ASSISTANT_DEFAULTS.scope,
      background: typeof value.background === "boolean" ? value.background : ASSISTANT_DEFAULTS.background,
      eagerness: value.eagerness && ASSISTANT_EAGERNESS.includes(value.eagerness) ? value.eagerness : ASSISTANT_DEFAULTS.eagerness,
    };
  } catch {
    return ASSISTANT_DEFAULTS;
  }
}
const AGENT = "assistant";

export function ChatReopenButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="chat-reopen-button shadow-md"
      onClick={onClick}
    >
      Open chat
    </Button>
  );
}

function withoutId(ids: ReadonlySet<string>, id: string) {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/** One run that did not finish, in the terms you would need to explain why. */
interface RunFailure {
  at: string;
  mode: "act" | "context" | "propose";
  /** `report` means the failure itself could not be handed to the room. */
  phase: LeasePhase | "report";
  status: "failed" | "cancelled";
  triggerId: string;
  attempt: number;
  runId: string;
  reason: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Binds one room to the thread panel.
 *
 * Everything the room knows arrives through `RoomTransport`; everything only
 * this client knows (what is unacknowledged, what is still streaming) stays in
 * `view` and never touches an entry. Swapping the mock for the real transport
 * is the one-line change at the top of this component.
 */
export function ChatPanel({
  roomId,
  roomTransport,
  onClose,
  className,
}: {
  roomId?: string;
  roomTransport?: RoomTransport;
  onClose?: () => void;
  className?: string;
}) {
  const agent = useAgent();
  const { editor, jumpToNode, selectedAnchors, shapeCount, labelForNode } = useCanvas();
  const cancelRef = React.useRef(agent.cancel);
  cancelRef.current = agent.cancel;
  React.useEffect(() => () => { void cancelRef.current(); }, [roomId]);
  const [userName, setUserName] = React.useState(DEFAULT_USER);
  const [userId, setUserId] = React.useState(DEFAULT_USER);
  const [assistantScope, setAssistantScope] = React.useState<AssistantScope>(() => readAssistantSettings(roomId).scope);
  const [backgroundChecks, setBackgroundChecks] = React.useState(() => readAssistantSettings(roomId).background);
  const [eagerness, setEagerness] = React.useState<AssistantEagerness>(() => readAssistantSettings(roomId).eagerness);
  /**
   * Which room the three settings above currently hold.
   *
   * They are read at first render rather than restored in an effect: both
   * effects run in the same commit, so a writer effect would persist the
   * defaults over whatever a reader effect had just queued, and StrictMode's
   * second pass would read those defaults back. Every assistant setting
   * silently reverted on reload. Resetting during render instead of in an
   * effect keeps that true when the room changes without a remount.
   */
  const settingsRoom = React.useRef(roomId);
  if (settingsRoom.current !== roomId) {
    settingsRoom.current = roomId;
    const saved = readAssistantSettings(roomId);
    setAssistantScope(saved.scope);
    setBackgroundChecks(saved.background);
    setEagerness(saved.eagerness);
  }

  const editorRef = React.useRef(editor);
  editorRef.current = editor;
  const userIdRef = React.useRef(userId);
  userIdRef.current = userId;
  const fallbackCanvasId = React.useRef(crypto.randomUUID());
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [leaseRevision, setLeaseRevision] = React.useState(0);
  const claiming = React.useRef(false);
  const reportError = React.useCallback((error: unknown) => setActionError(describeError(error)), []);

  /**
   * The last few assistant runs that did not finish.
   *
   * A failed run leaves an empty agent entry in the thread and a `failed`
   * trigger, and that is all anyone — user, QA report, driver session — has
   * ever been able to see. Keep the phase and the server's own words here so
   * "it just says Failed" stops being the end of the investigation. A ref, not
   * state: this is evidence about a render, not an input to one.
   */
  const runFailures = React.useRef<RunFailure[]>([]);
  const recordRunFailure = React.useCallback((failure: RunFailure) => {
    runFailures.current = [...runFailures.current, failure].slice(-10);
    console.error("kan: assistant run failed", failure);
    if (import.meta.env.DEV) (window as Window & { __kanRunFailures?: RunFailure[] }).__kanRunFailures = runFailures.current;
  }, []);

  const transport = React.useMemo<RoomTransport>(() => {
    if (roomTransport) return roomTransport;
    return createLocalTransport({
      canvasId: roomId ?? fallbackCanvasId.current,
      get userId() { return userIdRef.current; },
      getCanvas: () => assistantCanvasRecords(editorRef.current).map((shape) => ({ ...shape, props: { ...shape.props } })),
      applyOperations: (operations, provenance) => {
        if (!editorRef.current) throw new Error("The canvas is not ready");
        return applyAssistantOperations(editorRef.current, operations, provenance);
      },
    });
  }, [roomId, roomTransport]);

  const [entries, setEntries] = React.useState<ThreadEntry[]>([]);
  const entryOrderRef = React.useRef(new Map<string, number>());
  const nextEntryOrderRef = React.useRef(0);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  useQaSource("chat", () => ({
    roomId, entries, pendingIds: [...pendingIds],
    runFailures: runFailures.current,
  }));
  const models = agent.status.models?.available ?? [];
  const modelSelection: AiModelSelection = { id: agent.status.models?.current ?? "" };
  const [roomSnapshot, setRoomSnapshot] = React.useState(() => transport.snapshot());
  const activeLease = React.useRef<LeaseExecution | undefined>(undefined);
  const attempts = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!roomId) return;
    localStorage.setItem(`kan-assistant:${roomId}`, JSON.stringify({ scope: assistantScope, background: backgroundChecks, eagerness }));
  }, [assistantScope, backgroundChecks, eagerness, roomId]);

  React.useEffect(() => {
    transport.setExecutorReady(agent.status.state === "ready", agent.status.agent ?? "Kan", assistantScope, backgroundChecks);
  }, [agent.status.agent, agent.status.state, assistantScope, backgroundChecks, transport]);

  React.useEffect(() => {
    transport.setAssistantEagerness?.(eagerness);
  }, [eagerness, transport]);

  /** Upsert by id: a replay and a live append are the same operation. */
  const upsert = React.useCallback((entry: ThreadEntry) => {
    if (!entryOrderRef.current.has(entry.id)) {
      entryOrderRef.current.set(entry.id, nextEntryOrderRef.current++);
    }
    setEntries((prev) => {
      const index = prev.findIndex((existing) => existing.id === entry.id);
      if (index === -1) return [...prev, entry];
      return prev.map((existing, i) => (i === index ? entry : existing));
    });
  }, []);

  React.useEffect(() => {
    return transport.subscribe((entry) => {
      upsert(entry);
      // The room numbered it, so our optimistic copy is now the real thing.
      setPendingIds((prev) => withoutId(prev, entry.id));
    }, (snapshot) => {
      for (const line of snapshot.transcripts ?? []) {
        if (!entryOrderRef.current.has(line.id)) entryOrderRef.current.set(line.id, nextEntryOrderRef.current++);
      }
      setRoomSnapshot(snapshot);
      if (snapshot.ready && snapshot.room?.assistantEagerness) setEagerness(snapshot.room.assistantEagerness);
    });
  }, [transport, upsert]);

  const executeTrigger = React.useCallback(async (trigger: TriggerEntry) => {
    const key = `${trigger.triggerId}:${trigger.attempt}`;
    if (agent.busy || attempts.current.has(key) || activeLease.current || claiming.current) return;
    claiming.current = true;
    setActionError(null);
    let lease;
    try { lease = await transport.claimTrigger(trigger.triggerId); }
    finally { claiming.current = false; }
    if (!lease) return;
    attempts.current.add(key);
    const execution = startLeaseExecution({
      triggerId: trigger.triggerId,
      attempt: trigger.attempt,
      runId: lease.runId,
      leaseToken: lease.leaseToken,
      expiresAt: lease.expiresAt,
      mode: trigger.mode,
      getContext: async (signal) => {
        if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
        return (transport as LocalTransport).getLocalContext(lease.runId);
      },
      run: (mode, context, signal) => runAssistantTurn({ ready: agent.status.state === "ready", agentId: agent.status.agent ?? "Kan", run: (nextMode, nextContext, nextSignal) => agent.runStructured(nextMode, nextContext, nextSignal, trigger.anchors, lease.runId) }, mode, context, signal),
      heartbeat: () => (transport as LocalTransport).heartbeatLocal(lease.runId),
      complete: (input, signal) => {
        if (signal.aborted) return Promise.reject(new DOMException("assistant turn cancelled", "AbortError"));
        return (transport as LocalTransport).completeLocal(lease.runId, input);
      },
      fail: async (status, failure) => {
        const reason = describeError(failure.error);
        if (status === "failed") setActionError(`Kan could not finish this request (${failure.phase}): ${reason}`);
        // Record before telling the room, so a failure that itself fails to be
        // reported still leaves a trace.
        recordRunFailure({
          at: new Date().toISOString(), mode: trigger.mode, phase: failure.phase, status,
          triggerId: trigger.triggerId, attempt: trigger.attempt, runId: lease.runId, reason,
        });
        try {
          await (transport as LocalTransport).failLocal(lease.runId, status);
        } catch (error) {
          recordRunFailure({
            at: new Date().toISOString(), mode: trigger.mode, phase: "report", status,
            triggerId: trigger.triggerId, attempt: trigger.attempt, runId: lease.runId, reason: describeError(error),
          });
        }
      },
    });
    activeLease.current = execution;
    await execution.promise.finally(() => {
      if (activeLease.current === execution) activeLease.current = undefined;
      setLeaseRevision((revision) => revision + 1);
    });
  }, [agent, recordRunFailure, transport]);

  React.useEffect(() => {
    if (!roomId || !roomSnapshot.ready || !roomSnapshot.sessionId || agent.status.state !== "ready") return;
    for (const entry of entries) {
      if (entry.kind !== "trigger" || entry.status !== "offered" || entry.assigneeSessionId !== roomSnapshot.sessionId) continue;
      void executeTrigger(entry).catch(reportError);
    }
  }, [agent.status.state, entries, executeTrigger, leaseRevision, reportError, roomId, roomSnapshot.ready, roomSnapshot.sessionId]);

  React.useEffect(() => {
    const active = activeLease.current;
    if (!active) return;
    const trigger = roomSnapshot.triggers.find((candidate) => candidate.id === active.triggerId);
    if (!roomSnapshot.connected || agent.status.state !== "ready" || (trigger && ["cancelled", "failed", "expired"].includes(trigger.status))) active.controller.abort();
  }, [agent.status.state, roomSnapshot]);
  React.useEffect(() => () => { activeLease.current?.controller.abort(); }, [transport]);

  React.useEffect(() => {
    void getInstallationProfile().then((p) => {
      if (p?.name) {
        setUserName(p.name);
        setUserId(p.installationId);
      }
    });
  }, []);

  function handleSend({ text, files, replyToEntryId }: { text: string; files: File[]; replyToEntryId?: string }) {
    const id = crypto.randomUUID();
    const anchors = selectedAnchors;

    // Render it immediately, dimmed, and let the echo settle it. The room is
    // the thing that decides an entry exists; this is just a good guess.
    upsert({
      id,
      seq: PENDING_SEQ,
      kind: "message",
      at: new Date().toISOString(),
      authorId: userId,
      text,
      anchors,
    });
    setPendingIds((prev) => new Set(prev).add(id));

    void transport.send({
      id,
      text,
      anchors: anchors.map((anchor) => anchor.nodeId),
      files,
      source: "typed",
      replyToEntryId,
    }).catch(reportError);

  }

  function resolveSuggestion(suggestion: SuggestionEntry, accepted: boolean) {
    void transport.resolveSuggestion(suggestion.id, accepted).catch(reportError);
  }

  function claimTrigger(trigger: TriggerEntry) { if (!roomSnapshot.ready) return; void executeTrigger(trigger).catch(reportError); }
  function cancelTrigger(trigger: TriggerEntry) { if (activeLease.current?.triggerId === trigger.triggerId) activeLease.current.controller.abort(); void transport.cancelTrigger(trigger.triggerId).catch(reportError); }
  function retryTrigger(trigger: TriggerEntry) { void transport.retryTrigger(trigger.triggerId).catch(reportError); }
  function resolveOffer(offer: OfferEntry, accepted: boolean) { void transport.resolveOffer(offer.id, accepted).catch(reportError); }

  const participants = React.useMemo(() => {
    const humans = roomSnapshot.members.map((member) => ({ id: member.id, name: member.id === userId ? userName : member.name, kind: "human" as const }));
    const known = new Set(humans.map((member) => member.id));
    if (!known.has(userId)) { humans.unshift({ id: userId, name: userName, kind: "human" as const }); known.add(userId); }
    const agents = roomSnapshot.executors.filter((executor) => executor.agentId).map((executor) => ({ id: executor.agentId, name: executor.agentId, kind: "agent" as const, operatorId: executor.userId }));
    if (!agents.some((participant) => participant.id === AGENT)) agents.push({ id: AGENT, name: agent.status.agent ?? "Kan", kind: "agent", operatorId: userId });
    return [...humans, ...agents];
  }, [agent.status.agent, roomSnapshot.executors, roomSnapshot.members, userId, userName]);

  const chimeIn = toChimeIn(assistantScope, eagerness);
  /** Scope to restore when leaving "only when asked": lending survives going quiet. */
  const lastActiveScope = React.useRef<AssistantScope>(assistantScope === "manual" ? "own" : assistantScope);
  if (assistantScope !== "manual") lastActiveScope.current = assistantScope;
  const applyChimeIn = React.useCallback((value: ChimeIn) => {
    const next = fromChimeIn(value, lastActiveScope.current);
    setAssistantScope(next.scope);
    if (!next.eagerness) return;
    setEagerness(next.eagerness);
  }, []);

  /**
   * The one transient line above the stream.
   *
   * Only one of these can matter at a time and each is more urgent than the
   * one below it, so this is a priority list rather than a stack of rows. The
   * ambient transcription status is not here on purpose: it is always set, so
   * showing it would make the "only when there is something to say" slot
   * permanent. It lives in the footer instead.
   */
  const status = React.useMemo(() => {
    if (agent.busy) {
      return (
        <>
          <Spinner className="size-3" />
          <span className="flex-1">Kan is working</span>
          <Button variant="outline" size="xs" onClick={() => void agent.cancel()}>Cancel</Button>
        </>
      );
    }
    const error = actionError ?? roomSnapshot.error;
    if (!error) return null;
    return (
      <>
        <span role="status" className="flex-1 text-destructive">{error}</span>
      </>
    );
  }, [actionError, agent, roomSnapshot.error]);

  /**
   * Steps for turns that have already ended.
   *
   * The provider drops its live activity the moment a turn finishes, and the
   * room does not carry steps back, so the rail would blink out exactly when
   * someone wants to read it. Keeping the last state per run is enough for the
   * collapsed summary. Client-only: a reload forgets it, which is the right
   * trade for not writing tool noise into the room.
   */
  const finishedSteps = React.useRef(new Map<string, AgentStep[]>());
  const activity = agent.activity;
  if (activity.turnId && activity.steps.length) {
    finishedSteps.current.set(activity.turnId, activity.steps);
  }

  /** Paint live activity onto the agent entry for the run in flight. */
  const withActivity = React.useCallback(
    (entry: AgentEntry): AgentEntry => {
      const live = activity.turnId === entry.traceId;
      const steps = live
        ? activity.steps
        : (entry.steps?.length ? entry.steps : finishedSteps.current.get(entry.traceId ?? "") ?? []);
      if (!steps.length && !live) return entry;
      return {
        ...entry,
        steps,
        thought: live ? activity.thought : undefined,
        thinking: live ? !!activity.thoughtBuffer : undefined,
      };
    },
    [activity]
  );

  const liveEntries = React.useMemo(() => (roomSnapshot.transcripts ?? []).filter((line) => !entries.some((entry) => entry.id === line.id)).map((line) => ({ ...line, kind: "transcript" as const, seq: PENDING_SEQ })), [roomSnapshot.transcripts, entries]);
  const visibleEntries = React.useMemo(
    () => [...entries.map((entry) => (entry.kind === "agent" ? withActivity(entry) : entry)), ...liveEntries],
    [entries, liveEntries, withActivity]
  );
  /** A running agent turn is the one whose rail streams. */
  const streamingIds = React.useMemo(
    () => new Set(entries.filter((entry) => entry.kind === "agent" && entry.status === "running").map((entry) => entry.id)),
    [entries]
  );
  const view = React.useMemo(
    () => ({
      interimIds: new Set(liveEntries.map((line) => line.id)),
      streamingIds,
      pendingIds,
      entryOrder: entryOrderRef.current,
    }),
    [pendingIds, liveEntries, streamingIds]
  );

  return (
    <ThreadPanel
      className={className}
      channel={roomId ? `canvas/${roomId.slice(0, 8)}` : "#feature-kickoff"}
      entries={visibleEntries}
      participants={participants}
      currentUserId={userId}
      anchors={selectedAnchors}
      canvasNodeCount={shapeCount}
      view={view}
      headerAction={
        <AssistantMenu
          ready={agent.status.state === "ready"}
          agentName={agent.status.agent ?? undefined}
          chimeIn={chimeIn}
          onChimeInChange={applyChimeIn}
        />
      }
      status={status}
      onClose={onClose}
      onJumpToNode={jumpToNode}
      resolveAnchorLabel={labelForNode}
      onAcceptSuggestion={(suggestion) => resolveSuggestion(suggestion, true)}
      onDismissSuggestion={(suggestion) => resolveSuggestion(suggestion, false)}
      onClaimTrigger={claimTrigger}
      onCancelTrigger={cancelTrigger}
      onRetryTrigger={retryTrigger}
      onAcceptOffer={(offer) => resolveOffer(offer, true)}
      onDismissOffer={(offer) => resolveOffer(offer, false)}
      composer={{
        onSend: handleSend,
        disabled: userId === DEFAULT_USER || !roomSnapshot.ready,
        agentReady: agent.status.state === "ready",
        modelSelection: models.length ? modelSelection : undefined,
        models,
        modelDisabled: agent.busy || agent.status.state !== "ready",
        onModelSelectionChange: (selection) => { void agent.setModel(selection.id); },
      }}
    />
  );
}
