const iso = (value) =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(iso)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, iso(v)]))
        : typeof value === "bigint"
          ? Number(value)
          : value;
const rows = async (tx, sql, args) =>
  (await tx.query(sql, args)).rows.map((row) => iso(row));
async function insert(tx, table, row) {
  const columns = Object.keys(row);
  await tx.query(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    columns.map((column) => {
      const value = row[column];
      return value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value;
    }),
  );
}
export async function exportCanvas(db, canvasId) {
  return db.transaction(async (tx) => {
    const canvas = (
      await rows(tx, "SELECT * FROM web_canvases WHERE id=$1", [canvasId])
    )[0];
    if (!canvas) throw new Error("Canvas not found");
    const threads = await rows(
      tx,
      "SELECT * FROM web_threads WHERE canvas=$1 ORDER BY created_at,id",
      [canvasId],
    );
    const sessions = await rows(
      tx,
      "SELECT * FROM web_meeting_sessions WHERE canvas=$1 ORDER BY created_at,id",
      [canvasId],
    );
    const inThreads = "thread IN (SELECT id FROM web_threads WHERE canvas=$1)";
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      canvas,
      workspace: {
        ...(
          await rows(tx, "SELECT * FROM web_workspaces WHERE id=$1", [
            canvas.workspace,
          ])
        )[0],
        memberships: await rows(
          tx,
          "SELECT * FROM web_memberships WHERE workspace=$1 ORDER BY user_id",
          [canvas.workspace],
        ),
      },
      room: (await rows(tx, "SELECT * FROM web_rooms WHERE id=$1", [canvasId]))[0] ?? null,
      records: await rows(tx, "SELECT * FROM web_records WHERE room=$1 ORDER BY id", [canvasId]),
      events: await rows(tx, "SELECT * FROM web_events WHERE room=$1 ORDER BY seq", [canvasId]),
      threads,
      runs: await rows(tx, `SELECT * FROM web_runs WHERE ${inThreads} ORDER BY created_at,id`, [canvasId]),
      messages: await rows(tx, `SELECT * FROM web_messages WHERE ${inThreads} ORDER BY created_at,id`, [canvasId]),
      assets: await rows(tx, "SELECT * FROM web_assets WHERE canvas=$1 ORDER BY created_at,id", [canvasId]),
      meetingSessions: sessions,
      transcriptSegments: await rows(
        tx,
        "SELECT * FROM web_transcript_segments WHERE session IN (SELECT id FROM web_meeting_sessions WHERE canvas=$1) ORDER BY session,seq",
        [canvasId],
      ),
    };
  });
}
export async function importCanvas(db, snapshot, { workspace }) {
  if (snapshot?.version !== 1) throw new Error("Unsupported backup version");
  if (!workspace) throw new Error("Target workspace required");
  return db.transaction(async (tx) => {
    const existing = (
      await tx.query("SELECT id FROM web_canvases WHERE id=$1", [snapshot.canvas.id])
    ).rows[0];
    if (existing) {
      const error = new Error("Canvas already exists");
      error.status = 409;
      throw error;
    }
    const target = (
      await tx.query("SELECT id FROM web_workspaces WHERE id=$1", [workspace])
    ).rows[0];
    if (!target) throw new Error("Target workspace not found");
    const counts = {};
    const put = async (table, list) => {
      for (const row of list) await insert(tx, table, row);
      counts[table] = list.length;
    };
    await put("web_canvases", [{ ...snapshot.canvas, workspace }]);
    await put("web_rooms", snapshot.room ? [snapshot.room] : []);
    await put("web_records", snapshot.records);
    await put(
      "web_events",
      snapshot.events.map(({ seq, ...event }) => event),
    );
    await put("web_threads", snapshot.threads);
    await put("web_runs", snapshot.runs);
    await put("web_messages", snapshot.messages);
    await put("web_assets", snapshot.assets);
    await put("web_meeting_sessions", snapshot.meetingSessions);
    await put("web_transcript_segments", snapshot.transcriptSegments);
    return counts;
  });
}
