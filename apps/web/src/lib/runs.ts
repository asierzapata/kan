import { Client } from "eve/client";
import { randomUUID } from "node:crypto";
import { hash } from "@kan/web-core/hash";
import { canvasAccess, HttpError, text } from "./access";
import { scheduleContextRun } from "./meeting";
import { runCeilingReached } from "./policy";
export function agentClient() {
  return new Client({
    host: process.env.EVE_INTERNAL_URL!,
    auth: { bearer: process.env.STAGING_SECRET! },
    redirect: "manual",
  });
}
export async function enqueue(
  tx: any,
  canvas: string,
  user: string,
  input: any,
  authSessionId?: string,
) {
  await canvasAccess(tx, canvas, user, "editor");
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('web-evaluation-budget'))",
  );
  const prompt = text(input.message, 4000),
    operation = text(input.operation, 80),
    anchors = Array.isArray(input.anchors) ? input.anchors.slice(0, 30) : [];
  if (
    anchors.some(
      (id: any) => typeof id !== "string" || !id.startsWith("shape:"),
    )
  )
    throw new HttpError(400, "Invalid anchors");
  const inputHash = hash({ canvas, prompt, anchors, user });
  const prior = (
    await tx.query("SELECT * FROM web_runs WHERE operation=$1", [operation])
  ).rows[0];
  if (prior) {
    if (prior.input_hash !== inputHash)
      throw new HttpError(409, "Conflicting request");
    return prior;
  }
  const count = (await tx.query("SELECT count(*)::int AS count FROM web_runs"))
    .rows[0].count;
  if (runCeilingReached(count))
    throw new HttpError(429, "Configured agent run limit reached");
  let thread = input.thread;
  if (thread) {
    const row = (
      await tx.query("SELECT id FROM web_threads WHERE id=$1 AND canvas=$2", [
        thread,
        canvas,
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "Thread unavailable");
  } else {
    thread = randomUUID();
    await tx.query(
      "INSERT INTO web_threads(id,canvas,title) VALUES($1,$2,$3)",
      [thread, canvas, prompt.slice(0, 80)],
    );
  }
  const id = randomUUID();
  await tx.query(
    "INSERT INTO web_runs(id,thread,user_id,operation,input_hash,prompt,anchors,auth_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      thread,
      user,
      operation,
      inputHash,
      prompt,
      JSON.stringify(anchors),
      authSessionId ?? null,
    ],
  );
  await tx.query(
    "INSERT INTO web_messages(id,thread,run,user_id,role,content,anchors) VALUES($1,$2,$3,$4,'user',$5,$6)",
    [id, thread, id, user, prompt, JSON.stringify(anchors)],
  );
  return { id, thread, status: "queued" };
}
export async function dispatch(
  db: any,
  canvas: string,
  client = agentClient(),
  clock: () => number = Date.now,
) {
  // SQL advisory lock serializes the entire canvas queue across Vercel instances.
  return db
    .transaction(async (tx: any) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [canvas]);
      const active = (
        await tx.query(
          "SELECT r.* FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE t.canvas=$1 AND r.status IN ('running','dispatching','cancelling') ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r",
          [canvas],
        )
      ).rows[0];
      if (active) {
        if (!active.session_id) return { pending: true };
        const snapshot: any = await client.sessions
          .attach(active.session_id)
          .snapshot();
        const events = snapshot.events || [];
        for (const event of events)
          if (
            event.type === "message.completed" &&
            event.data?.message &&
            event.data.finishReason !== "tool-calls"
          )
            await tx.query(
              "INSERT INTO web_messages(id,thread,run,role,content,evidence) VALUES($1,$2,$3,'assistant',$4,$5) ON CONFLICT DO NOTHING",
              [
                event.meta.id,
                active.thread,
                active.id,
                event.data.message,
                JSON.stringify(
                  active.kind === "context"
                    ? [
                        {
                          session: active.meeting_session,
                          from: active.context_from,
                          to: active.context_to,
                        },
                      ]
                    : [],
                ),
              ],
            );
        let status = events.some((e: any) => e.type === "turn.cancelled")
          ? "cancelled"
          : events.some(
                (e: any) =>
                  e.type === "turn.failed" || e.type === "session.failed",
              )
            ? "failed"
            : events.some((e: any) => e.type === "turn.completed")
              ? events.some(
                  (event: any) =>
                    event.type === "action.result" &&
                    event.data.result?.isError,
                )
                ? "failed"
                : "complete"
              : events.some((e: any) => e.type === "input.requested")
                ? "paused"
                : null;
        if (
          !status && active.status === "dispatching" &&
          active.dispatched_at && Date.now() - Date.parse(active.dispatched_at) > 300000 &&
          !events.some((event: any) => event.type === "turn.started")
        ) status = "failed";
        // Unknown acceptance is observed, never automatically sent a second time.
        // A parked session with no turn eventually becomes a visible failure;
        // explicit retry retires it only after checking saved mutation receipts.
        if (!status) return { pending: true };
        await tx.query("UPDATE web_runs SET status=$2 WHERE id=$1", [
          active.id,
          status,
        ]);
      }
      const context = await scheduleContextRun(tx, canvas, clock);
      const run = (
        await tx.query(
          "SELECT r.* FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE t.canvas=$1 AND r.status='queued' ORDER BY (r.kind='request') DESC,r.created_at,r.id LIMIT 1 FOR UPDATE OF r",
          [canvas],
        )
      ).rows[0];
      if (!run) return { pending: context.waiting };
      try {
        await canvasAccess(tx, canvas, run.user_id, "editor");
        if (run.auth_session_id) {
          const { assertActiveSession } = await import("./session");
          await assertActiveSession(run.user_id, run.auth_session_id);
        }
      } catch {
        await tx.query("UPDATE web_runs SET status='denied' WHERE id=$1", [
          run.id,
        ]);
        return { pending: true };
      }
      // Persist a parked session before dispatch. An ambiguous dispatch is never
      // automatically resent: reconciliation observes its durable events instead.
      const created = await client.sessions.create();
      const sessionId = created.session.state.sessionId;
      await tx.query(
        "UPDATE web_runs SET session_id=$2,status='dispatching',dispatched_at=now() WHERE id=$1",
        [run.id, sessionId],
      );
      return { pending: true, send: { ...run, sessionId } };
    })
    .then(async (result: any) => {
      if (result.send) {
        const run = result.send;
        try {
          await client.sessions.attach(run.sessionId).send(run.prompt, {
            clientContext: {
              anchors: run.anchors,
              history: (
                await db.query(
                  "SELECT role,content FROM web_messages WHERE thread=$1 ORDER BY created_at DESC LIMIT 20",
                  [run.thread],
                )
              ).rows.reverse(),
            },
          });
          await db.query(
            "UPDATE web_runs SET status='running' WHERE id=$1 AND status='dispatching'",
            [run.id],
          );
        } catch {
          /* unknown acceptance; retain dispatching for reconciliation */
        }
      }
      return { pending: result.pending };
    });
}

export async function retryRun(
  tx: any, canvas: string, user: string, runId: string,
  authSessionId: string, client = agentClient(),
) {
  await canvasAccess(tx, canvas, user, "editor");
  const run = (await tx.query(
    "SELECT r.* FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.id=$1 AND t.canvas=$2 FOR UPDATE OF r",
    [runId, canvas],
  )).rows[0];
  if (!run || !["failed", "denied"].includes(run.status))
    throw new HttpError(409, "Only failed turns can be retried");
  if (run.user_id !== user)
    throw new HttpError(403, "Only the author can retry this turn");
  const receipts = (await tx.query(
    "SELECT operation FROM web_events WHERE room=$1 AND operation LIKE $2 LIMIT 1",
    [canvas, run.id + ":%"],
  )).rows;
  if (receipts.length)
    throw new HttpError(409, "This turn saved changes. Inspect the canvas and submit a new contextual request.");
  if (run.retry_count >= 2)
    throw new HttpError(429, "Staging retry limit reached");
  // Terminal database status fences late tools. Retire the old runtime only after
  // checking receipts and budget; rejection must preserve its recovery evidence.
  if (run.session_id)
    await client.sessions.attach(run.session_id).reset({ reason: "Retry a failed authorized turn" });
  await tx.query(
    "UPDATE web_runs SET status='queued',session_id=NULL,retry_count=retry_count+1,auth_session_id=$2 WHERE id=$1",
    [run.id, authSessionId],
  );
  return { queued: true };
}

async function workerTool(body: any) {
  const response = await fetch(`${process.env.STAGING_WORKER_URL}/tool`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.STAGING_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new HttpError(409, "Undo could not be applied");
  return response.json();
}
export async function revertRun(
  tx: any,
  canvas: string,
  user: string,
  runId: string,
  callWorker: (body: any) => Promise<any> = workerTool,
) {
  await canvasAccess(tx, canvas, user, "editor");
  const run = (
    await tx.query(
      "SELECT r.* FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.id=$1 AND t.canvas=$2 FOR UPDATE OF r",
      [runId, canvas],
    )
  ).rows[0];
  if (!run) throw new HttpError(404, "Run unavailable");
  if (!["complete", "failed", "cancelled"].includes(run.status))
    throw new HttpError(409, "Only finished turns can be reverted");
  if (run.reverted_at) throw new HttpError(409, "This turn was already reverted");
  const events = (
    await tx.query(
      "SELECT changes FROM web_events WHERE room=$1 AND operation LIKE $2 ORDER BY revision",
      [canvas, `${run.id}:%`],
    )
  ).rows;
  const created = new Map<string, any>(),
    updated = new Set<string>();
  for (const { changes } of events) {
    for (const doc of changes.puts) {
      const id = doc.state.id;
      if (id.startsWith(`shape:${run.id}:`) || id.startsWith(`binding:${run.id}:`))
        created.set(id, doc);
      else updated.add(id);
    }
    for (const id of changes.removes) created.delete(id);
  }
  const candidates = [...created.values()].map((doc) => ({
    id: doc.state.id,
    hash: hash(doc),
    stateHash: hash(doc.state),
  }));
  const outcome = candidates.length
    ? await callWorker({
        canvas,
        user,
        run: run.id,
        operation: `revert:${run.id}:${randomUUID()}`,
        name: "revertRun",
        input: { candidates },
      })
    : { removed: [], kept: [], revision: null };
  await tx.query("UPDATE web_runs SET reverted_at=now() WHERE id=$1", [run.id]);
  return {
    removed: outcome.removed,
    kept: outcome.kept,
    skippedUpdates: [...updated],
    revision: outcome.revision,
  };
}
