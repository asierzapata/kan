import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "@kan/web-core/hash";
import { canvasAccess, HttpError, text } from "./access";
import { readMeetingContextInput } from "./meeting-schema";
export { readMeetingContextInput };
export const CONTEXT_SETTLE_MS = 8000;
export const CONTEXT_MAX_WAIT_MS = 45000;
export const CONTEXT_RUN_CAP = 20;
const segmentInput = z.object({
  sourceId: z.string().min(1).max(120),
  speaker: z.string().min(1).max(80),
  text: z.string().min(1).max(2000),
  startedAtMs: z.number().int().min(0),
  endedAtMs: z.number().int().min(0).optional(),
  final: z.boolean(),
});
const segmentsInput = z.object({
  session: z.uuid(),
  segments: z.array(segmentInput).min(1).max(50),
});
const statusInput = z.object({
  session: z.uuid(),
  status: z.enum(["paused", "listening", "ended"]),
});
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Invalid meeting input");
  return result.data;
}
async function ownedSession(tx: any, canvas: string, id: string) {
  const row = (
    await tx.query(
      "SELECT * FROM web_meeting_sessions WHERE id=$1 AND canvas=$2 FOR UPDATE",
      [id, canvas],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Meeting unavailable");
  return row;
}
export async function startMeeting(
  tx: any,
  canvas: string,
  user: string,
  input: any,
) {
  await canvasAccess(tx, canvas, user, "editor");
  const label = text(input?.label, 120);
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `meeting:${canvas}`,
  ]);
  const open = (
    await tx.query(
      "SELECT id FROM web_meeting_sessions WHERE canvas=$1 AND status<>'ended' LIMIT 1",
      [canvas],
    )
  ).rows[0];
  if (open) throw new HttpError(409, "A meeting is already active");
  const thread = randomUUID(),
    id = randomUUID();
  await tx.query("INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,$3)", [
    thread,
    canvas,
    `Meeting: ${label}`,
  ]);
  await tx.query(
    "INSERT INTO web_meeting_sessions(id,canvas,thread,source,label,created_by) VALUES($1,$2,$3,'synthetic',$4,$5)",
    [id, canvas, thread, label, user],
  );
  return { id, thread, status: "listening" };
}
export async function ingestSegments(
  tx: any,
  canvas: string,
  user: string,
  input: any,
  clock: () => number = Date.now,
) {
  await canvasAccess(tx, canvas, user, "editor");
  const { session: sessionId, segments } = parse(segmentsInput, input);
  const session = await ownedSession(tx, canvas, sessionId);
  if (session.status === "ended") throw new HttpError(409, "Meeting has ended");
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [session.id]);
  const now = clock();
  const outcomes: { sourceId: string; seq: number; outcome: string }[] = [];
  let changed = false;
  for (const segment of segments) {
    const row = (
      await tx.query(
        "SELECT seq,text,final FROM web_transcript_segments WHERE session=$1 AND source_id=$2",
        [session.id, segment.sourceId],
      )
    ).rows[0];
    if (!row) {
      const seq = (
        await tx.query(
          "INSERT INTO web_transcript_segments(session,source_id,seq,speaker,text,started_at_ms,ended_at_ms,final,received_at) VALUES($1,$2,(SELECT coalesce(max(seq),0)+1 FROM web_transcript_segments WHERE session=$1),$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000)) RETURNING seq",
          [
            session.id,
            segment.sourceId,
            segment.speaker,
            segment.text,
            segment.startedAtMs,
            segment.endedAtMs ?? null,
            segment.final,
            now,
          ],
        )
      ).rows[0].seq;
      outcomes.push({ sourceId: segment.sourceId, seq, outcome: "inserted" });
      changed = true;
    } else if (row.text === segment.text && row.final === segment.final) {
      outcomes.push({
        sourceId: segment.sourceId,
        seq: row.seq,
        outcome: "duplicate",
      });
    } else if (row.final && !segment.final) {
      outcomes.push({
        sourceId: segment.sourceId,
        seq: row.seq,
        outcome: "ignored-stale",
      });
    } else {
      await tx.query(
        "UPDATE web_transcript_segments SET text=$3,ended_at_ms=$4,final=$5,revision=revision+1 WHERE session=$1 AND source_id=$2",
        [
          session.id,
          segment.sourceId,
          segment.text,
          segment.endedAtMs ?? null,
          segment.final,
        ],
      );
      outcomes.push({
        sourceId: segment.sourceId,
        seq: row.seq,
        outcome: "replaced",
      });
      changed = true;
    }
  }
  const updated = (
    await tx.query(
      "UPDATE web_meeting_sessions SET pending_cursor=coalesce((SELECT max(seq) FROM web_transcript_segments WHERE session=$1 AND final),0), last_segment_at=CASE WHEN $2 THEN to_timestamp($3::double precision/1000) ELSE last_segment_at END WHERE id=$1 RETURNING pending_cursor,processed_cursor",
      [session.id, changed, now],
    )
  ).rows[0];
  return {
    outcomes,
    pendingCursor: updated.pending_cursor,
    processedCursor: updated.processed_cursor,
  };
}
export async function setMeetingStatus(
  tx: any,
  canvas: string,
  user: string,
  input: any,
) {
  await canvasAccess(tx, canvas, user, "editor");
  const { session: sessionId, status } = parse(statusInput, input);
  const session = await ownedSession(tx, canvas, sessionId);
  if (session.status === "ended") {
    if (status === "ended") return session;
    throw new HttpError(409, "Meeting has ended");
  }
  return (
    await tx.query(
      "UPDATE web_meeting_sessions SET status=$2,pause_reason=CASE WHEN $2='listening' THEN NULL ELSE pause_reason END,ended_at=CASE WHEN $2='ended' THEN now() ELSE ended_at END WHERE id=$1 RETURNING *",
      [session.id, status],
    )
  ).rows[0];
}
export async function meetingState(tx: any, canvas: string, user: string) {
  await canvasAccess(tx, canvas, user, "viewer");
  const session =
    (
      await tx.query(
        "SELECT * FROM web_meeting_sessions WHERE canvas=$1 ORDER BY (status<>'ended') DESC,created_at DESC LIMIT 1",
        [canvas],
      )
    ).rows[0] ?? null;
  if (!session) return { session: null, segments: [], contextRuns: [] };
  const segments = (
    await tx.query(
      "SELECT * FROM (SELECT * FROM web_transcript_segments WHERE session=$1 ORDER BY seq DESC LIMIT 200) s ORDER BY seq",
      [session.id],
    )
  ).rows;
  const contextRuns = (
    await tx.query(
      "SELECT id,status,context_from,context_to,created_at FROM web_runs WHERE kind='context' AND meeting_session=$1 ORDER BY created_at,id",
      [session.id],
    )
  ).rows;
  return { session, segments, contextRuns };
}
export async function readMeetingContext(tx: any, run: any, input: any) {
  if (!run.meeting_session)
    throw new HttpError(404, "No meeting context for this run");
  const parsed = readMeetingContextInput.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(400, "Invalid meeting context range");
  const from = parsed.data.from ?? run.context_from ?? 0,
    to = parsed.data.to ?? run.context_to ?? 2147483647,
    limit = parsed.data.limit ?? 200;
  const session = (
    await tx.query(
      "SELECT id,label,status FROM web_meeting_sessions WHERE id=$1",
      [run.meeting_session],
    )
  ).rows[0];
  if (!session) throw new HttpError(404, "No meeting context for this run");
  const segments = (
    await tx.query(
      "SELECT seq,speaker,text,started_at_ms,ended_at_ms,final FROM web_transcript_segments WHERE session=$1 AND final AND seq BETWEEN $2 AND $3 ORDER BY seq LIMIT $4",
      [session.id, from, to, limit],
    )
  ).rows;
  return {
    session: { id: session.id, label: session.label, status: session.status },
    range: { from, to },
    segments: segments.map((s: any) => ({
      seq: s.seq,
      speaker: s.speaker,
      text: s.text,
      startedAtMs: s.started_at_ms,
      endedAtMs: s.ended_at_ms,
      final: s.final,
    })),
  };
}
export async function scheduleContextRun(
  tx: any,
  canvas: string,
  clock: () => number = Date.now,
): Promise<{ scheduled: boolean; waiting: boolean; run?: any }> {
  const session = (
    await tx.query(
      "SELECT * FROM web_meeting_sessions WHERE canvas=$1 AND status='listening' AND pending_cursor>processed_cursor LIMIT 1 FOR UPDATE",
      [canvas],
    )
  ).rows[0];
  if (!session) return { scheduled: false, waiting: false };
  const busy = (
    await tx.query(
      "SELECT 1 FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE t.canvas=$1 AND r.status IN ('queued','running','dispatching','cancelling') LIMIT 1",
      [canvas],
    )
  ).rows[0];
  if (busy) return { scheduled: false, waiting: true };
  const now = clock();
  const settled =
    session.last_segment_at != null &&
    now - new Date(session.last_segment_at).getTime() >= CONTEXT_SETTLE_MS;
  const oldest = (
    await tx.query(
      "SELECT received_at FROM web_transcript_segments WHERE session=$1 AND final AND seq>$2 ORDER BY seq LIMIT 1",
      [session.id, session.processed_cursor],
    )
  ).rows[0];
  const overdue =
    oldest != null &&
    now - new Date(oldest.received_at).getTime() >= CONTEXT_MAX_WAIT_MS;
  if (!settled && !overdue) return { scheduled: false, waiting: true };
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('web-evaluation-budget'))",
  );
  const total = (await tx.query("SELECT count(*)::int AS count FROM web_runs"))
    .rows[0].count;
  if (session.context_runs >= CONTEXT_RUN_CAP || total >= 20) {
    await tx.query(
      "UPDATE web_meeting_sessions SET status='paused',pause_reason='budget' WHERE id=$1",
      [session.id],
    );
    return { scheduled: false, waiting: false };
  }
  const from = session.processed_cursor + 1,
    to = session.pending_cursor,
    id = randomUUID(),
    prompt = `Meeting context segments ${from}–${to} arrived. Call readMeetingContext, then getCanvas. Capture decisions, action items and open questions by updating agent-owned nodes or adding concise new notes. Never delete or overwrite human-authored nodes. If nothing is worth recording, reply in one sentence and make no changes.`;
  await tx.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,anchors,auth_session_id,kind,meeting_session,context_from,context_to) VALUES($1,$2,$3,$4,$5,$6,'[]',NULL,'context',$7,$8,$9)",
    [
      id,
      session.thread,
      session.created_by,
      randomUUID(),
      hash({ canvas, context: [from, to] }),
      prompt,
      session.id,
      from,
      to,
    ],
  );
  await tx.query(
    "INSERT INTO web_messages(id,thread,run,role,content,evidence) VALUES($1,$2,$3,'context',$4,$5)",
    [
      id,
      session.thread,
      id,
      `Meeting context ${from}–${to}`,
      JSON.stringify([{ session: session.id, from, to }]),
    ],
  );
  await tx.query(
    "UPDATE web_meeting_sessions SET processed_cursor=pending_cursor,context_runs=context_runs+1 WHERE id=$1",
    [session.id],
  );
  return {
    scheduled: true,
    waiting: false,
    run: { id, thread: session.thread, status: "queued" },
  };
}
