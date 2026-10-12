import { TLSocketRoom } from "@tldraw/sync-core";
import { randomUUID } from "node:crypto";
import { hash } from "@kan/web-core/hash";

// Experimental socket barrier, not a PostgreSQL TLSyncStorage implementation.
// All document-changing entry points MUST be serialized through transact().
export class Coordinator {
  static async open(persistence, id, options = {}) {
    const seed = new TLSocketRoom({ schema: options.schema });
    const initial = seed.getCurrentSnapshot();
    seed.close();
    const state = await persistence.acquire(id, initial);
    return new Coordinator(persistence, id, state, options);
  }
  constructor(persistence, id, state, options) {
    this.persistence = persistence;
    this.id = id;
    this.epoch = state.epoch;
    this.revision = state.revision;
    this.room = new TLSocketRoom({
      initialSnapshot: state.snapshot,
      schema: options.schema,
      ...options.roomOptions,
    });
    this.options = options;
    this.pending = false;
    this.dead = false;
    this.outbound = [];
    this.sockets = new Set();
    this.tail = Promise.resolve();
  }
  connect(sessionId, socket, isReadonly = false) {
    const job = this.tail.then(() => {
      if (this.dead || socket.readyState !== 1)
        throw new Error("Coordinator unavailable");
      this.sockets.add(socket);
      this.room.handleSocketConnect({
        sessionId,
        isReadonly,
        socket: {
          get readyState() {
            return socket.readyState;
          },
          send: (data) => {
            if (this.pending) this.outbound.push(() => socket.send(data));
            else socket.send(data);
          },
          close: (code, reason) => socket.close(code, reason),
        },
      });
    });
    this.tail = job.catch(() => {});
    return job;
  }
  transact(operation, input, apply, durable = false) {
    const job = this.tail.then(async () => {
      if (this.dead) throw new Error("Coordinator unavailable");
      this.pending = true;
      if (durable) {
        try {
          const receipt = await this.persistence.receipt(
            this.id,
            operation,
            input,
          );
          if (receipt) {
            this.pending = false;
            for (const send of this.outbound.splice(0)) send();
            return receipt.revision;
          }
        } catch (error) {
          this.pending = false;
          this.close();
          throw error;
        }
      }
      const beforeSnapshot = this.room.getCurrentSnapshot();
      const before = hash(beforeSnapshot);
      try {
        await apply(this.room);
        const snapshot = this.room.getCurrentSnapshot();
        if (durable || hash(snapshot) !== before) {
          await this.options.beforeCommit?.();
          this.revision = await this.persistence.commit(
            this.id,
            this.epoch,
            this.revision,
            operation,
            input,
            recordChanges(beforeSnapshot, snapshot),
          );
          await this.options.afterCommit?.();
        }
        this.pending = false;
        for (const send of this.outbound.splice(0)) send();
      } catch (error) {
        this.outbound = [];
        this.pending = false;
        this.close();
        throw error;
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
  receive(sessionId, data, actor) {
    // Transport-attempt ID only. Durable semantic tool IDs are supplied by callers.
    return this.transact(
      randomUUID(),
      actor ? { frame: data, actor } : data,
      (room) => room.handleSocketMessage(sessionId, data),
    );
  }
  mutate(operation, records, expectedRevision) {
    return this.transact(
      operation,
      records,
      (room) => {
        if (
          expectedRevision !== undefined &&
          expectedRevision !== this.revision
        )
          throw new Error("Stale agent revision");
        return room.updateStore((store) =>
          records.forEach((record) => store.put(record)),
        );
      },
      true,
    );
  }
  close() {
    this.dead = true;
    this.room.close();
    for (const socket of this.sockets) socket.close();
  }
}

export function recordChanges(before, after) {
  const old = new Map(before.documents.map((doc) => [doc.state.id, doc]));
  const puts = [];
  for (const doc of after.documents) {
    if (hash(old.get(doc.state.id) ?? null) !== hash(doc)) puts.push(doc);
    old.delete(doc.state.id);
  }
  const { documents, ...metadata } = after;
  const changes = { puts, removes: [...old.keys()], metadata };
  if (
    puts.length + changes.removes.length > 500 ||
    JSON.stringify(changes).length > 2 * 1024 * 1024
  )
    throw Error("Bounded commit exceeded");
  return changes;
}
