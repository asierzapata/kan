import { hash } from "./hash.mjs";
import { migration } from "./migration.mjs";

// Snapshot metadata is small (schema, clocks, tombstones). Document bodies live in
// separate rows; each durable event contains only changed records and removals.
export class Persistence {
  constructor(db) {
    this.db = db;
  }
  async migrate() {
    await this.db.exec(migration);
  }
  async acquire(id, initial) {
    return this.db.transaction(async (tx) => {
      const { documents, ...metadata } = initial;
      const inserted = await tx.query(
        "INSERT INTO web_rooms(id,metadata) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [id, JSON.stringify(metadata)],
      );
      if (inserted.rows.length)
        for (const doc of documents)
          await tx.query(
            "INSERT INTO web_records(room,id,payload) VALUES($1,$2,$3)",
            [id, doc.state.id, JSON.stringify(doc)],
          );
      const row = (
        await tx.query(
          "UPDATE web_rooms SET epoch=epoch+1 WHERE id=$1 RETURNING *",
          [id],
        )
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
  async commit(id, epoch, revision, operation, input, changes) {
    return this.db.transaction(async (tx) => {
      if (input?.actor) {
        const actor = input.actor;
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
      }
      const current = (
        await tx.query("SELECT * FROM web_rooms WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!current || current.epoch !== epoch)
        throw new Error("Fenced coordinator");
      const prior = (
        await tx.query(
          "SELECT * FROM web_events WHERE room=$1 AND operation=$2",
          [id, operation],
        )
      ).rows[0];
      if (prior) {
        if (prior.input_hash !== hash(input))
          throw new Error("Conflicting operation");
        return prior.revision;
      }
      if (current.revision !== revision) throw new Error("Stale revision");
      const { puts, removes, metadata } = changes;
      if (
        !Array.isArray(puts) ||
        !Array.isArray(removes) ||
        puts.length + removes.length > 500 ||
        JSON.stringify(changes).length > 2 * 1024 * 1024
      )
        throw new Error("Commit exceeds bounded record limits");
      if (
        new Set([...puts.map((doc) => doc.state.id), ...removes]).size !==
        puts.length + removes.length
      )
        throw new Error("Duplicate record IDs");
      for (const doc of puts) {
        const src = doc.state.props?.src;
        if (
          (typeof src === "string" && src.startsWith("/api/assets")) ||
          (typeof src === "string" &&
            src.startsWith("https://staging.getkan.dev/api/assets"))
        ) {
          const assetId = new URL(
            src,
            "https://staging.getkan.dev",
          ).searchParams.get("id");
          const asset = (
            await tx.query(
              "SELECT id FROM web_assets WHERE id=$1 AND canvas=$2",
              [assetId, id],
            )
          ).rows[0];
          if (!asset) throw new Error("Asset belongs to another canvas");
        }
        if (
          typeof src === "string" &&
          !src.startsWith("/api/assets?id=") &&
          !src.startsWith("https://")
        )
          throw new Error("Invalid image URL");
      }
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
      await tx.query(
        "UPDATE web_rooms SET revision=revision+1,metadata=$2 WHERE id=$1",
        [id, JSON.stringify(metadata)],
      );
      await tx.query(
        "INSERT INTO web_events(room,revision,operation,input_hash,changes) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          revision + 1,
          operation,
          hash(input),
          JSON.stringify({ puts, removes, metadata }),
        ],
      );
      return revision + 1;
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
        "SELECT * FROM web_events WHERE room=$1 AND revision>$2 ORDER BY revision LIMIT 1000",
        [id, after],
      )
    ).rows;
  }
}
