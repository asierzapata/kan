import { hash } from "./hash.mjs";
import { migration } from "./migration.mjs";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Snapshot metadata is small (schema, clocks, tombstones). Document bodies live in
// separate rows; each durable event contains only changed records and removals.
export class Persistence {
  constructor(db) {
    this.db = db;
  }
  async migrate() {
    await this.db.exec(migration);
  }
  // `initial` is a fresh RoomSnapshot (e.g. `new InMemorySyncStorage().getSnapshot()`)
  // used only to create the room row; the canvas must exist and not be deleted.
  async load(id, initial) {
    return this.db.transaction(async (tx) => {
      const canvas = (
        await tx.query(
          "SELECT id FROM web_canvases WHERE id=$1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0];
      if (!canvas) throw new HttpError(404, "Canvas unavailable");
      const { documents, ...metadata } = initial;
      const inserted = await tx.query(
        "INSERT INTO web_rooms(id,revision,metadata) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
        [id, metadata.documentClock ?? 0, JSON.stringify(metadata)],
      );
      if (inserted.rows.length)
        for (const doc of documents)
          await tx.query(
            "INSERT INTO web_records(room,id,payload) VALUES($1,$2,$3)",
            [id, doc.state.id, JSON.stringify(doc)],
          );
      const row = (
        await tx.query("SELECT * FROM web_rooms WHERE id=$1", [id])
      ).rows[0];
      row.snapshot = {
        ...row.metadata,
        documents: (
          await tx.query(
            "SELECT payload FROM web_records WHERE room=$1 ORDER BY id",
            [id],
          )
        ).rows.map((r) => r.payload),
      };
      return row;
    });
  }
  async assertActor(id, actor) {
    await this.db.transaction(async (tx) => {
      const access = (
        await tx.query(
          "SELECT m.role FROM web_canvases c JOIN web_memberships m ON m.workspace=c.workspace WHERE c.id=$1 AND c.deleted_at IS NULL AND m.user_id=$2 AND m.role IN ('owner','editor') FOR SHARE OF c,m",
          [id, actor.user],
        )
      ).rows[0];
      if (!access) throw new Error("Write access revoked");
      if (actor.run) {
        const active = (
          await tx.query(
            "SELECT id FROM web_runs WHERE id=$1 AND session_id=$2 AND status IN ('running','dispatching') FOR SHARE",
            [actor.run, actor.session],
          )
        ).rows[0];
        if (!active) throw new Error("Run cancelled or replaced");
      }
    });
  }
  async persist(id, { revision, metadata, puts, removes, operation, input }) {
    return this.db.transaction(async (tx) => {
      if (
        !Array.isArray(puts) ||
        !Array.isArray(removes) ||
        (input?.actor &&
          (puts.length + removes.length > 500 ||
            JSON.stringify({ puts, removes, metadata }).length > 2 * 1024 * 1024))
      )
        throw new Error("Commit exceeds bounded record limits");
      if (
        new Set([...puts.map((doc) => doc.state.id), ...removes]).size !==
        puts.length + removes.length
      )
        throw new Error("Duplicate record IDs");
      for (const doc of puts)
        await tx.query(
          "INSERT INTO web_records(room,id,payload) VALUES($1,$2,$3) ON CONFLICT(room,id) DO UPDATE SET payload=EXCLUDED.payload",
          [id, doc.state.id, JSON.stringify(doc)],
        );
      for (const recordId of removes)
        await tx.query("DELETE FROM web_records WHERE room=$1 AND id=$2", [
          id,
          recordId,
        ]);
      await tx.query("UPDATE web_rooms SET revision=$2,metadata=$3 WHERE id=$1", [
        id,
        revision,
        JSON.stringify(metadata),
      ]);
      if (operation)
        await tx.query(
          "INSERT INTO web_events(room,revision,operation,input_hash,changes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room,operation) DO NOTHING",
          [
            id,
            revision,
            operation,
            hash(input),
            JSON.stringify({ puts, removes, metadata }),
          ],
        );
    });
  }
  async receipt(id, operation, input) {
    const row = (
      await this.db.query(
        "SELECT * FROM web_events WHERE room=$1 AND operation=$2",
        [id, operation],
      )
    ).rows[0];
    if (row && row.input_hash !== hash(input))
      throw new Error("Conflicting operation");
    return row;
  }
  async replay(id, after = 0) {
    return (
      await this.db.query(
        "SELECT * FROM web_events WHERE room=$1 AND revision>$2 ORDER BY seq LIMIT 1000",
        [id, after],
      )
    ).rows;
  }
}
