import { AssistantResultSchema, CONTEXT_MAX_AGE_MS, CONTEXT_SETTLE_MS, DEFAULT_EAGERNESS, eagernessPacing, type AssistantEagerness, EntrySchema, explicitInvocation, type AssistantResult, type Entry, type Lease, type Mutation, type NodeDraft, type Trigger } from "@kan/protocol";
import { toViewEntry, type RoomTransport, type SendInput, type RoomSnapshot } from "./transport";
import type { AssistantPreferences } from "./assistant-controller";
import type { ThreadEntry } from "./thread";
import { localThreadStorage, type LocalThreadStorage } from "./local-thread-store";
import { stepsFromMutations } from "./agent-steps";

export interface LocalCanvasRecord { id: string; type?: string; props?: Record<string, unknown>; [key: string]: unknown }
export interface LocalTransportOptions {
  canvasId: string;
  userId: string;
  getCanvas: () => LocalCanvasRecord[];
  applyOperations: (operations: Mutation[], provenance: Record<string, string>) => string[];
  storage?: LocalThreadStorage;
}
export interface LocalTransport extends RoomTransport {
  getLocalContext(runId: string): Promise<{ revision: string; value: unknown }>;
  completeLocal(runId: string, input: { id: string; revision: string; result: AssistantResult }): Promise<void>;
  failLocal(runId: string, status: "failed" | "cancelled"): Promise<void>;
  heartbeatLocal(runId: string): Promise<{ expiresAt: number }>;
}

export function createLocalTransport(options: LocalTransportOptions): LocalTransport {
  const storage = options.storage ?? localThreadStorage;
  const sessionId = crypto.randomUUID();
  const listeners = new Set<(entry: ThreadEntry) => void>();
  const snapshots = new Set<(snapshot: RoomSnapshot) => void>();
  const leases = new Map<string, Lease>();
  const contexts = new Map<string, { revision: string; canvasRevision: string; entryIds: Set<string>; shapes: LocalCanvasRecord[]; value: unknown }>();
  const completions = new Set<string>();
  const fresh = new Set<string>();
  let entries: Entry[] = [];
  let preferences: AssistantPreferences = { scope: "own", background: false };
  let capable = false, agentId = "Kan", initialized = false, owner = false, stopped = false;
  let init: Promise<void> | undefined, release: (() => void) | undefined;
  let queue = Promise.resolve();
  let cooldownUntil = 0;
  let pacing = eagernessPacing(DEFAULT_EAGERNESS);
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  // Deadline for the current batch of causes: restarting the settle timer must
  // not defer the check past it, or a room that keeps talking is never checked.
  let contextDeadline = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let problem: string | undefined;
  const at = () => new Date().toISOString();
  const base = () => ({ id: crypto.randomUUID(), roomId: options.canvasId, seq: Math.max(0, ...entries.map((entry) => entry.seq)) + 1, at: at() });
  const triggerEntry = (id: string) => entries.find((entry): entry is Extract<Entry, { kind: "trigger" }> => entry.kind === "trigger" && entry.trigger.id === id);
  const turnEntry = (runId: string) => entries.find((entry): entry is Extract<Entry, { kind: "agent_turn" }> => entry.kind === "agent_turn" && entry.runId === runId);
  const snapshot = (): RoomSnapshot => ({ connected: initialized && owner, ready: initialized && owner, sessionId: initialized && owner ? sessionId : null, members: [{ id: options.userId, name: "You" }], executors: [{ sessionId, userId: options.userId, ready: capable, agentId, scope: preferences.scope, background: preferences.background, busy: entries.some((entry) => entry.kind === "trigger" && entry.trigger.status === "running") }], triggers: entries.flatMap((entry) => entry.kind === "trigger" ? [entry.trigger] : []), error: problem });
  const publish = () => {
    for (const entry of entries) { const view = toViewEntry(entry); if (view) for (const listener of listeners) listener(view); }
    for (const listener of snapshots) listener(snapshot());
  };
  const initialize = () => init ??= (async () => {
    const hydrate = async () => {
      entries = await storage.read(options.canvasId);
      if (owner) {
        let changed = false;
        for (const entry of entries) {
          if (entry.kind === "trigger" && ["running", "offered", "pending"].includes(entry.trigger.status)) {
            entry.trigger.status = entry.trigger.status === "running" ? "failed" : "needs_claim";
            entry.trigger.assigneeSessionId = null;
            entry.trigger.offerExpiresAt = null;
            changed = true;
          }
          if (entry.kind === "agent_turn" && entry.status === "running") { entry.status = "failed"; changed = true; }
        }
        if (changed) await storage.write(options.canvasId, entries);
      }
      initialized = true;
      publish();
    };
    if (options.storage) { owner = true; await hydrate(); return; }
    if (!globalThis.navigator?.locks) throw new Error("This webview cannot safely claim local work.");
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request(`kan-assistant:${options.canvasId}`, { ifAvailable: true }, async (lock) => {
        owner = Boolean(lock);
        if (!owner) problem = "This canvas is open in another window. Close that window before running Kan here.";
        try { await hydrate(); resolve(); } catch (error) { reject(error); return; }
        if (lock && !stopped) await new Promise<void>((done) => { release = done; });
      }).catch(reject);
    });
  })().catch((error) => { problem = error instanceof Error ? error.message : "Could not open the local thread"; publish(); throw error; });
  const transact = <T,>(fn: () => Promise<T> | T): Promise<T> => {
    const task = queue.then(async () => {
      await initialize();
      if (!owner || stopped) throw new Error(problem ?? "The local canvas is no longer active");
      const result = await fn();
      try {
        await storage.write(options.canvasId, entries);
      } catch (error) {
        problem = "Could not save the local thread. Reopen this canvas before continuing.";
        stopped = true;
        publish();
        throw error;
      }
      publish();
      return result;
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  };
  const canvasRevision = () => JSON.stringify([...options.getCanvas()].sort((a, b) => a.id.localeCompare(b.id)));
  const revision = async () => {
    const shapes = [...options.getCanvas()].sort((a, b) => a.id.localeCompare(b.id));
    const humanSeq = Math.max(0, ...entries.filter((entry) => entry.kind === "message").map((entry) => entry.seq));
    const resolutions = entries.filter((entry) => (entry.kind === "suggestion" || entry.kind === "offer") && entry.status !== "open");
    const bytes = new TextEncoder().encode(JSON.stringify({ shapes, humanSeq, resolutions }));
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const refreshOffers = () => {
    if (entries.some((entry) => entry.kind === "trigger" && entry.trigger.status === "running")) return;
    const candidates = entries.flatMap((entry) => entry.kind === "trigger" && fresh.has(entry.trigger.id) && ["pending", "offered", "needs_claim"].includes(entry.trigger.status) ? [entry] : []).sort((a, b) => Number(a.trigger.mode !== "act") - Number(b.trigger.mode !== "act") || a.seq - b.seq);
    let assigned = false;
    for (const entry of candidates) {
      const trigger = entry.trigger;
      if (trigger.mode !== "act" && Date.now() - (trigger.createdAt ?? 0) > CONTEXT_MAX_AGE_MS) { trigger.status = "expired"; continue; }
      const allowed = capable && preferences.scope !== "manual" && (trigger.mode === "act" || preferences.background);
      trigger.status = allowed && !assigned ? "offered" : "needs_claim";
      trigger.assigneeSessionId = allowed && !assigned ? sessionId : null;
      trigger.offerExpiresAt = null;
      if (allowed) assigned = true;
    }
  };
  const addTrigger = (causeEntryIds: string[], mode: "act" | "context", approval?: { request: string; offerId: string }) => {
    // The nodes selected when the request was made are what the request is
    // about, so they are also what the canvas lights up while Kan works.
    const anchors = [...new Set(entries.flatMap((entry) => causeEntryIds.includes(entry.id) && entry.kind === "message" ? entry.anchors : []))].slice(0, 64);
    const trigger: Trigger = { id: crypto.randomUUID(), causeEntryIds, requestedBy: options.userId, reason: approval?.request.slice(0, 1000) ?? (mode === "act" ? "Requested assistance" : "Check whether a grounded contribution would help"), intent: "answer", mode, anchors, confidence: 1, status: "needs_claim", assigneeSessionId: null, offerExpiresAt: null, attempt: 0, runId: null, source: approval ? "accepted" : mode === "act" ? "explicit" : "context", createdAt: Date.now(), ...(approval ? { approvedRequest: approval.request, acceptedOfferId: approval.offerId } : {}) };
    entries.push({ ...base(), kind: "trigger", trigger });
    fresh.add(trigger.id);
    refreshOffers();
    return trigger;
  };
  const activeRun = (runId: string) => {
    const lease = leases.get(runId), turn = turnEntry(runId);
    const trigger = turn ? triggerEntry(turn.triggerId)?.trigger : undefined;
    if (!lease || !turn || !trigger || trigger.status !== "running" || trigger.runId !== runId || turn.status !== "running" || lease.expiresAt <= Date.now()) throw new Error("This run is no longer active");
    return { lease, turn, trigger };
  };
  const finish = (runId: string, status: "failed" | "cancelled") => {
    const turn = turnEntry(runId);
    const trigger = turn ? triggerEntry(turn.triggerId)?.trigger : undefined;
    if (turn && turn.status === "running") turn.status = status;
    if (trigger?.status === "running") { trigger.status = status; trigger.assigneeSessionId = null; }
    leases.delete(runId);
    refreshOffers();
  };
  const scheduleContext = () => {
    clearTimeout(contextTimer);
    if (!capable || !preferences.background || preferences.scope === "manual") return;
    if (pacing.maxWaitMs > 0 && contextDeadline <= Date.now()) contextDeadline = Date.now() + pacing.maxWaitMs;
    contextTimer = setTimeout(() => {
      contextDeadline = 0;
      void transact(() => {
        if (!capable || !preferences.background || Date.now() < cooldownUntil) return;
        if (entries.some((entry) => (entry.kind === "trigger" && ["pending", "offered", "running", "needs_claim"].includes(entry.trigger.status)) || ((entry.kind === "offer" || entry.kind === "suggestion") && entry.status === "open"))) return;
        const causes = entries.filter((entry) => entry.kind === "message").slice(-20).map((entry) => entry.id);
        if (!causes.length) return;
        addTrigger(causes, "context");
        cooldownUntil = Date.now() + pacing.cooldownMs;
      }).catch((error) => { problem = String(error); publish(); });
    }, pacing.maxWaitMs > 0 ? Math.max(0, Math.min(CONTEXT_SETTLE_MS, contextDeadline - Date.now())) : CONTEXT_SETTLE_MS);
  };
  return {
    subscribe(listener, onSnapshot) {
      clearTimeout(closeTimer);
      stopped = false;
      listeners.add(listener);
      if (onSnapshot) snapshots.add(onSnapshot);
      void initialize().then(publish).catch(() => undefined);
      return () => {
        listeners.delete(listener);
        if (onSnapshot) snapshots.delete(onSnapshot);
        if (!listeners.size) closeTimer = setTimeout(() => { stopped = true; clearTimeout(contextTimer); release?.(); }, 0);
      };
    },
    send(input: SendInput) {
      return transact(() => {
        if (input.files.length) throw new Error("Local thread attachments are not ingested yet. Add evidence to the canvas instead.");
        const prior = entries.find((entry) => entry.id === input.id);
        if (prior) { if (prior.kind === "message" && prior.text === input.text) return; throw new Error("Message ID already used"); }
        const message: Entry = { ...base(), id: input.id, kind: "message", authorId: options.userId, text: input.text, anchors: input.anchors, attachments: [], source: input.source ?? "typed", ...(input.replyToEntryId ? { replyToEntryId: input.replyToEntryId } : {}) };
        EntrySchema.parse(message);
        const reply = entries.find((entry) => entry.id === input.replyToEntryId);
        entries.push(message);
        if (explicitInvocation(input.text, input.source ?? "typed") || (reply && ["agent_turn", "suggestion", "offer"].includes(reply.kind))) {
          clearTimeout(contextTimer);
          addTrigger([message.id, ...(reply ? [reply.id] : [])], "act");
        } else scheduleContext();
      });
    },
    claimTrigger(triggerId) {
      return transact(() => {
        if (!capable) throw new Error("Connect an agent before running this request");
        const trigger = triggerEntry(triggerId)?.trigger;
        if (!trigger || !["offered", "pending", "needs_claim"].includes(trigger.status)) throw new Error("This request is no longer claimable");
        if (entries.some((entry) => entry.kind === "trigger" && entry.trigger.status === "running")) throw new Error("Kan is already working on this canvas");
        const lease: Lease = { runId: crypto.randomUUID(), triggerId, attempt: trigger.attempt + 1, leaseToken: crypto.randomUUID(), expiresAt: Date.now() + 30_000, entryId: crypto.randomUUID() };
        trigger.status = "running"; trigger.runId = lease.runId; trigger.attempt = lease.attempt; trigger.assigneeSessionId = sessionId;
        leases.set(lease.runId, lease);
        entries.push({ ...base(), id: lease.entryId, kind: "agent_turn", triggerId, runId: lease.runId, byUserId: options.userId, agentId, text: "", status: "running", steps: [], touchedShapeIds: [], hidden: trigger.mode !== "act" });
        return lease;
      });
    },
    getLocalContext(runId) {
      return transact(async () => {
        const { trigger } = activeRun(runId);
        const allShapes = options.getCanvas();
        const shapes = [...allShapes].sort((a, b) => Number(trigger.anchors.includes(b.id)) - Number(trigger.anchors.includes(a.id))).slice(0, 50).map((shape) => JSON.parse(JSON.stringify(shape)) as LocalCanvasRecord);
        const recentEntries = entries.slice(-40);
        const causeEntries = entries.filter((entry) => trigger.causeEntryIds.includes(entry.id));
        const rev = await revision();
        const value = { trigger, causeEntries, recentEntries, canvas: { shapes, truncated: allShapes.length > shapes.length }, revision: rev };
        contexts.set(runId, { revision: rev, canvasRevision: canvasRevision(), entryIds: new Set([...causeEntries, ...recentEntries].map((entry) => entry.id)), shapes, value });
        return { revision: rev, value };
      });
    },
    heartbeatLocal(runId) { return transact(() => { const { lease } = activeRun(runId); lease.expiresAt = Date.now() + 30_000; return { expiresAt: lease.expiresAt }; }); },
    completeLocal(runId, input) {
      return transact(async () => {
        if (completions.has(`${runId}:${input.id}`)) return;
        const { trigger, turn } = activeRun(runId);
        let result = AssistantResultSchema.parse(input.result);
        const context = contexts.get(runId);
        if (!context || context.revision !== input.revision) throw new Error("Run context is missing or stale");
        if (trigger.mode !== "act" && result.kind === "act") throw new Error("Context checks cannot change the canvas");
        if (trigger.mode === "act" && result.kind === "silent") throw new Error("Explicit requests require a response");
        if (result.kind !== "silent") {
          if (trigger.mode !== "act" && !result.sources.length) throw new Error("Contextual contributions require evidence");
          for (const source of result.sources) {
            const sourceEntry = entries.find((entry) => entry.id === source.id);
            if (source.kind === "entry" ? !context.entryIds.has(source.id) || !sourceEntry || ["agent_turn", "trigger"].includes(sourceEntry.kind) : !context.shapes.some((shape) => shape.id === source.id)) throw new Error("The response cited unavailable evidence");
          }
        }
        if (await revision() !== context.revision) {
          if (trigger.mode !== "act") result = { kind: "silent" };
          else if (result.kind !== "reply" && canvasRevision() !== context.canvasRevision) throw new Error("The canvas changed while this action was running. Retry this request with current context.");
        }
        if (result.kind === "act") {
          turn.touchedShapeIds = options.applyOperations(result.operations, { entryId: turn.id, runId, agentId, byUserId: options.userId });
          // A durable record of what the turn did, so the thread's collapsed
          // step rail survives a reload rather than living only in the client.
          turn.steps = stepsFromMutations(result.operations);
        }
        if (result.kind === "offer") entries.push({ ...base(), kind: "offer", triggerId: trigger.id, runId, title: result.title, request: result.request, text: result.text, sources: result.sources, status: "open", resolvedBy: null, resultTriggerId: null, revision: context.revision });
        if (result.kind === "draft") {
          const target = result.targetShapeId ? context.shapes.find((shape) => shape.id === result.targetShapeId) : undefined;
          if (result.targetShapeId && (target?.type !== "kan-node" || !target.props?.draft)) throw new Error("Draft target is not an available shared Kan card");
          entries.push({ ...base(), kind: "suggestion", triggerId: trigger.id, runId, draft: result.draft, status: "open", shapeId: null, text: result.text, sources: result.sources, revision: context.revision, resolvedBy: null, ...(result.targetShapeId ? { targetShapeId: result.targetShapeId, expectedDraft: target!.props!.draft as NodeDraft } : {}) });
        }
        turn.text = result.kind === "silent" ? "" : result.text;
        if (result.kind !== "silent") turn.sources = result.sources;
        turn.hidden = ["silent", "draft", "offer"].includes(result.kind);
        turn.status = "done";
        trigger.status = "done"; trigger.assigneeSessionId = null;
        completions.add(`${runId}:${input.id}`);
        leases.delete(runId);
        refreshOffers();
      });
    },
    failLocal(runId, status) { return transact(() => finish(runId, status)); },
    resolveSuggestion(entryId, accepted) {
      return transact(async () => {
        const entry = entries.find((candidate) => candidate.id === entryId);
        if (entry?.kind !== "suggestion") throw new Error("Suggestion not found");
        const resolution = accepted ? "accepted" : "dismissed";
        if (entry.status === resolution) return;
        if (entry.status !== "open") throw new Error(`Suggestion is ${entry.status}`);
        if (accepted && entry.revision !== await revision()) { entry.status = "outdated"; return; }
        if (accepted) {
          const target = entry.targetShapeId ? options.getCanvas().find((shape) => shape.id === entry.targetShapeId) : undefined;
          if (entry.targetShapeId && (!target || JSON.stringify(target.props?.draft) !== JSON.stringify(entry.expectedDraft))) { entry.status = "outdated"; return; }
          const operation: Mutation = entry.targetShapeId ? { type: "update", shapeId: entry.targetShapeId, draft: entry.draft } : { type: "add", shapeId: `shape:${entry.id}`, draft: entry.draft };
          const touched = options.applyOperations([operation], { entryId: entry.id, runId: entry.runId, agentId, byUserId: options.userId, acceptedBy: options.userId });
          entry.shapeId = touched[0] ?? null;
          entry.acceptedBy = options.userId;
          const origin = turnEntry(entry.runId);
          if (origin) origin.touchedShapeIds = [...new Set([...origin.touchedShapeIds, ...touched])];
        }
        entry.status = resolution; entry.resolvedBy = options.userId;
      });
    },
    resolveOffer(entryId, accepted) {
      return transact(async () => {
        const entry = entries.find((candidate) => candidate.id === entryId);
        if (entry?.kind !== "offer") throw new Error("Offer not found");
        const resolution = accepted ? "accepted" : "dismissed";
        if (entry.status === resolution) return;
        if (entry.status !== "open") throw new Error(`Offer is ${entry.status}`);
        if (accepted && entry.revision !== await revision()) { entry.status = "outdated"; return; }
        entry.status = resolution; entry.resolvedBy = options.userId;
        if (accepted) entry.resultTriggerId = addTrigger([entry.id, ...entry.sources.filter((source) => source.kind === "entry").map((source) => source.id)].slice(0, 20), "act", { request: entry.request, offerId: entry.id }).id;
      });
    },
    cancelTrigger(triggerId) {
      return transact(() => {
        const trigger = triggerEntry(triggerId)?.trigger;
        if (!trigger || trigger.status === "done") throw new Error("This request cannot be cancelled");
        if (trigger.runId) finish(trigger.runId, "cancelled");
        trigger.status = "cancelled"; trigger.assigneeSessionId = null;
        refreshOffers();
      });
    },
    retryTrigger(triggerId) {
      return transact(() => {
        const trigger = triggerEntry(triggerId)?.trigger;
        if (!trigger || !["failed", "cancelled", "expired"].includes(trigger.status)) throw new Error("This request cannot be retried");
        trigger.status = "pending"; trigger.runId = null; trigger.createdAt = Date.now();
        fresh.add(triggerId); refreshOffers();
      });
    },
    setAssistantEagerness(value: AssistantEagerness) {
      pacing = eagernessPacing(value);
      scheduleContext();
    },
    setExecutorReady(ready, name, scope, background) {
      capable = ready; agentId = name; preferences = { scope, background };
      void transact(() => {
        for (const entry of entries) if (entry.kind === "trigger" && entry.trigger.mode !== "act" && (!background || scope === "manual") && ["pending", "offered", "needs_claim", "running"].includes(entry.trigger.status)) {
          if (entry.trigger.runId) finish(entry.trigger.runId, "cancelled");
          entry.trigger.status = "cancelled"; entry.trigger.assigneeSessionId = null;
        }
        refreshOffers();
      }).catch((error) => { problem = String(error); publish(); });
    },
    snapshot,
  };
}
