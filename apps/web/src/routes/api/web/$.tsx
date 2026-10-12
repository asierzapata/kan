import { createFileRoute } from "@tanstack/react-router";
import { activeAuth, assertActiveSession } from "../../../lib/session";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { enqueue, dispatch, agentClient, retryRun, revertRun } from "../../../lib/runs";
import {
  startMeeting,
  ingestSegments,
  setMeetingStatus,
  meetingState,
  readMeetingContext,
} from "../../../lib/meeting";
import { database } from "../../../lib/database";
import { RunStreamBoundary } from "../../../lib/run-stream";
import {
  canvasAccess,
  workspaceAccess,
  HttpError,
  text,
  tokenHash,
} from "../../../lib/access";

export const Route = createFileRoute("/api/web/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.split("/api/web/")[1];
  try {
    const { db, persistence } = await database();
    if (path === "internal") {
      const supplied = Buffer.from(request.headers.get("authorization") || ""),
        expected = Buffer.from(`Bearer ${process.env.STAGING_SECRET}`);
      if (
        !process.env.STAGING_SECRET ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected) ||
        request.method !== "POST"
      )
        throw new HttpError(401, "Unauthorized");
      const body = await request.json();
      if (body.action === "pending-canvases")
        return json({
          canvases: (
            await db.query(
              "SELECT DISTINCT canvas FROM (SELECT t.canvas FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.status IN ('queued','running','dispatching','cancelling') UNION SELECT canvas FROM web_meeting_sessions WHERE status='listening' AND pending_cursor>processed_cursor) c LIMIT 100",
            )
          ).rows.map((row: any) => row.canvas),
        });
      if (body.action === "dispatch")
        return json(await dispatch(db, body.canvas));
      if (body.action === "arm-recovery") {
        if (process.env.KAN_ENV !== "staging")
          throw new HttpError(403, "Fixture operation unavailable");
        const row = (
          await db.query(
            "UPDATE web_runs r SET qa_fault_pending=true FROM web_threads t,web_canvases c WHERE r.id=$1 AND r.thread=t.id AND t.canvas=c.id AND c.name LIKE 'QA %' AND r.status IN ('queued','running','dispatching') RETURNING r.id",
            [body.run],
          )
        ).rows[0];
        if (!row) throw new HttpError(403, "Synthetic run required");
        return json({ armed: true });
      }
      if (body.action === "tool") {
        const run = (
          await db.query(
            "SELECT r.*,t.canvas FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.session_id=$1 AND r.status IN ('running','dispatching')",
            [body.session],
          )
        ).rows[0];
        if (!run) throw new HttpError(403, "Run unavailable");
        if (run.auth_session_id)
          await assertActiveSession(run.user_id, run.auth_session_id);
        await db.transaction((tx: any) =>
          canvasAccess(tx, run.canvas, run.user_id, "editor"),
        );
        if (
          body.name === "getCanvas" &&
          body.input?.scope === "selection" &&
          !body.input.shapeIds
        )
          body.input = { ...body.input, shapeIds: run.anchors };
        if (body.name === "readMeetingContext")
          return json(
            await db.transaction((tx: any) =>
              readMeetingContext(tx, run, body.input),
            ),
          );
        if (body.name === "addMermaidDiagram") {
          const { parseDiagram } = await import("../../../lib/diagrams");
          body.diagram = await parseDiagram(body.input);
        }
        const response = await fetch(`${process.env.STAGING_WORKER_URL}/tool`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.STAGING_SECRET}`,
          },
          body: JSON.stringify({
            ...body,
            canvas: run.canvas,
            operation: `${run.id}:${body.callId}`,
            run: run.id,
            user: run.user_id,
          }),
        });
        if (response.ok && body.name !== "getCanvas" && run.qa_fault_pending) {
          const result = await response.json();
          const armed =
            (
              await db.query(
                "UPDATE web_runs SET qa_fault_pending=false,qa_fault_exercised=true WHERE id=$1 AND qa_fault_pending=true RETURNING id",
                [run.id],
              )
            ).rows.length > 0;
          return json({ ...result, crashForQa: armed });
        }
        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
      if (body.action === "authorize") {
        if (body.sessionId)
          await assertActiveSession(body.user, body.sessionId);
        return json(
          await db.transaction(async (tx: any) =>
            canvasAccess(
              tx,
              body.canvas,
              body.user,
              body.write ? "editor" : "viewer",
            ),
          ),
        );
      }
      if (
        !["acquire", "commit", "receipt", "replay"].includes(body.action) ||
        !Array.isArray(body.args)
      )
        throw new HttpError(400, "Invalid command");
      const canvas = (
        await db.query(
          "SELECT id FROM web_canvases WHERE id=$1 AND deleted_at IS NULL",
          [body.room],
        )
      ).rows[0];
      if (!canvas) throw new HttpError(404, "Canvas unavailable");
      return json({
        result: await persistence[body.action](body.room, ...body.args),
      });
    }
    const { user, sessionId } = await activeAuth();
    if (!user)
      throw new HttpError(401, "Your session expired. Sign in to continue.");
    if (
      request.method === "POST" &&
      request.headers.get("origin") !== url.origin
    )
      throw new HttpError(403, "Invalid origin");
    if (
      request.method !== "POST" &&
      !["catalog", "members", "room", "history", "stream", "meeting"].includes(path)
    )
      throw new HttpError(405, "POST required");
    const input =
      request.method === "POST"
        ? await request.json()
        : Object.fromEntries(url.searchParams);
    if (path === "stream") {
      await db.transaction((tx: any) =>
        canvasAccess(tx, input.canvas, user.id),
      );
      const run = (
        await db.query(
          "SELECT r.session_id FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.id=$1 AND t.canvas=$2",
          [input.run, input.canvas],
        )
      ).rows[0];
      if (!run?.session_id) throw new HttpError(404, "Run not started");
      const stream = agentClient()
        .sessions.attach(run.session_id)
        .stream({ follow: true, signal: request.signal });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              const boundary = new RunStreamBoundary();
              for await (const event of stream) {
                await assertActiveSession(user.id, sessionId);
                await db.transaction((tx: any) =>
                  canvasAccess(tx, input.canvas, user.id),
                );
                controller.enqueue(
                  encoder.encode(JSON.stringify(event) + "\n"),
                );
                if (boundary.settled(event)) break;
              }
              controller.close();
            } catch {
              controller.error(new Error("Stream unavailable"));
            }
          },
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          },
        },
      );
    }
    const result = await db.transaction(async (tx: any) => {
      if (path === "catalog") {
        const workspaces = (
          await tx.query(
            "SELECT w.*,m.role FROM web_workspaces w JOIN web_memberships m ON m.workspace=w.id WHERE m.user_id=$1 ORDER BY w.created_at",
            [user.id],
          )
        ).rows;
        const canvases = (
          await tx.query(
            "SELECT c.*,m.role FROM web_canvases c JOIN web_memberships m ON m.workspace=c.workspace WHERE m.user_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at",
            [user.id],
          )
        ).rows;
        return { workspaces, canvases };
      }
      if (path === "workspace/create") {
        const id = randomUUID();
        await tx.query("INSERT INTO web_workspaces(id,name) VALUES($1,$2)", [
          id,
          text(input.name),
        ]);
        await tx.query(
          "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,'owner')",
          [id, user.id, user.email.toLowerCase()],
        );
        return { id };
      }
      if (path === "invitation/accept") {
        const invite = (
          await tx.query(
            "SELECT * FROM web_invitations WHERE token_hash=$1 FOR UPDATE",
            [tokenHash(text(input.token, 200))],
          )
        ).rows[0];
        if (
          !invite ||
          new Date(invite.expires_at).getTime() <= Date.now() ||
          invite.email !== user.email.toLowerCase() ||
          (invite.accepted_by && invite.accepted_by !== user.id)
        )
          throw new HttpError(403, "Invitation unavailable for this account");
        if (invite.accepted_by) {
          await workspaceAccess(tx, invite.workspace, user.id);
          return { workspace: invite.workspace };
        }
        await tx.query(
          "INSERT INTO web_memberships(workspace,user_id,email,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [invite.workspace, user.id, user.email.toLowerCase(), invite.role],
        );
        await tx.query(
          "UPDATE web_invitations SET accepted_by=$2 WHERE id=$1",
          [invite.id, user.id],
        );
        return { workspace: invite.workspace };
      }
      if (path === "invitation/create") {
        await workspaceAccess(tx, input.workspace, user.id, "owner");
        const token = randomBytes(32).toString("base64url");
        if (
          !["editor", "viewer"].includes(input.role) ||
          !/^\S+@\S+\.\S+$/.test(input.email)
        )
          throw new HttpError(400, "Invalid invitation");
        await tx.query(
          "INSERT INTO web_invitations(id,workspace,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
          [
            randomUUID(),
            input.workspace,
            input.email.toLowerCase(),
            input.role,
            tokenHash(token),
          ],
        );
        return { url: `${url.origin}/?invite=${token}` };
      }
      if (path === "members") {
        await workspaceAccess(tx, input.workspace, user.id, "owner");
        return {
          members: (
            await tx.query(
              "SELECT user_id,email,role FROM web_memberships WHERE workspace=$1",
              [input.workspace],
            )
          ).rows,
        };
      }
      if (path === "member/revoke") {
        await workspaceAccess(tx, input.workspace, user.id, "owner");
        await tx.query(
          "DELETE FROM web_memberships WHERE workspace=$1 AND user_id=$2 AND role<>'owner'",
          [input.workspace, input.user],
        );
        return { revoked: true };
      }
      if (path === "member/role") {
        await workspaceAccess(tx, input.workspace, user.id, "owner");
        if (!["editor", "viewer"].includes(input.role))
          throw new HttpError(400, "Choose editor or viewer");
        const row = (
          await tx.query(
            "UPDATE web_memberships SET role=$3 WHERE workspace=$1 AND user_id=$2 AND role<>'owner' RETURNING user_id",
            [input.workspace, input.user, input.role],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "Member unavailable");
        return { changed: true };
      }
      if (path === "canvas/create") {
        await workspaceAccess(tx, input.workspace, user.id, "editor");
        const id = randomUUID();
        await tx.query(
          "INSERT INTO web_canvases(id,workspace,name) VALUES($1,$2,$3)",
          [id, input.workspace, text(input.name)],
        );
        return { id };
      }
      const canvas = await canvasAccess(
        tx,
        input.canvas,
        user.id,
        request.method === "POST" ? "editor" : "viewer",
      );
      if (path === "canvas/rename") {
        await tx.query("UPDATE web_canvases SET name=$2 WHERE id=$1", [
          canvas.id,
          text(input.name),
        ]);
        return { renamed: true };
      }
      if (path === "canvas/delete") {
        await tx.query("UPDATE web_canvases SET deleted_at=now() WHERE id=$1", [
          canvas.id,
        ]);
        return { deleted: true };
      }
      if (path === "chat") {
        return enqueue(tx, canvas.id, user.id, input, sessionId);
      }
      if (path === "history") {
        return {
          threads: (
            await tx.query(
              "SELECT * FROM web_threads WHERE canvas=$1 ORDER BY created_at",
              [canvas.id],
            )
          ).rows,
          messages: (
            await tx.query(
              "SELECT m.* FROM web_messages m JOIN web_threads t ON t.id=m.thread WHERE t.canvas=$1 ORDER BY m.created_at,m.id",
              [canvas.id],
            )
          ).rows,
          runs: (
            await tx.query(
              "SELECT r.id,r.thread,r.user_id,r.status,r.session_id,r.created_at,r.kind,r.meeting_session,r.context_from,r.context_to,r.reverted_at FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE t.canvas=$1 ORDER BY r.created_at",
              [canvas.id],
            )
          ).rows,
        };
      }
      if (path === "meeting/start")
        return startMeeting(tx, canvas.id, user.id, input);
      if (path === "meeting/segments")
        return ingestSegments(tx, canvas.id, user.id, input);
      if (path === "meeting/status")
        return setMeetingStatus(tx, canvas.id, user.id, input);
      if (path === "meeting") return meetingState(tx, canvas.id, user.id);
      if (path === "run/revert")
        return revertRun(tx, canvas.id, user.id, input.run);
      if (path === "retry") {
        return retryRun(tx, canvas.id, user.id, input.run, sessionId);
      }
      if (path === "cancel") {
        const run = (
          await tx.query(
            "SELECT r.* FROM web_runs r JOIN web_threads t ON t.id=r.thread WHERE r.id=$1 AND t.canvas=$2 FOR UPDATE OF r",
            [input.run, canvas.id],
          )
        ).rows[0];
        if (!run) throw new HttpError(404, "Run unavailable");
        if (run.session_id) {
          await agentClient().sessions.attach(run.session_id).cancel();
          await tx.query(
            "UPDATE web_runs SET status='cancelling' WHERE id=$1 AND status IN ('running','dispatching')",
            [run.id],
          );
        } else
          await tx.query(
            "UPDATE web_runs SET status='cancelled' WHERE id=$1 AND status='queued'",
            [run.id],
          );
        return { cancelled: true };
      }
      if (path === "room") {
        const body = Buffer.from(
          JSON.stringify({
            room: canvas.id,
            sub: user.id,
            sessionId,
            role: canvas.role,
            exp: Date.now() + 60000,
          }),
        ).toString("base64url");
        const signature = createHmac("sha256", process.env.STAGING_SECRET!)
          .update(body)
          .digest("base64url");
        return {
          uri: `${process.env.STAGING_WORKER_URL!.replace("https:", "wss:")}/sync?ticket=${body}.${signature}`,
          canvas,
        };
      }
      throw new HttpError(404, "Not found");
    });
    if (
      ["chat", "retry", "cancel", "meeting/segments", "meeting/status"].includes(
        path,
      )
    )
      await fetch(`${process.env.STAGING_WORKER_URL}/wake`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.STAGING_SECRET}`,
        },
        body: JSON.stringify({ canvas: input.canvas }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    return json(result);
  } catch (error: any) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    console.error("web.request.failed", {
      path,
      name: error?.name,
      code: error?.code,
      message: String(error?.message ?? "").slice(0, 200),
    });
    return json({ error: "Service unavailable" }, 503);
  }
}
