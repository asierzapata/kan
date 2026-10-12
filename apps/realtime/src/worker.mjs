import { planTool } from "./tools.ts";
import { DurableObject } from "cloudflare:workers";
import { Coordinator } from "./coordinator.mjs";
import { RemotePersistence } from "./remote.mjs";
import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema";
import {
  markdownShapeProps,
  chartShapeProps,
  tableShapeProps,
  imageShapeProps,
  mapShapeProps,
  logoShapeProps,
  timelineShapeProps,
  calendarShapeProps,
} from "../../../apps/desktop/src/nodes/shapes/types.ts";
const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "kan-markdown": { props: markdownShapeProps },
    "kan-chart": { props: chartShapeProps },
    "kan-table": { props: tableShapeProps },
    "kan-image": { props: imageShapeProps },
    "kan-map": { props: mapShapeProps },
    "kan-logo": { props: logoShapeProps },
    "kan-timeline": { props: timelineShapeProps },
    "kan-calendar": { props: calendarShapeProps },
  },
});
async function authorize(env, canvas, user, write = false, sessionId) {
  const r = await fetch(`${env.WEB_API_URL}/internal`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.STAGING_SECRET}`,
    },
    body: JSON.stringify({
      action: "authorize",
      canvas,
      user,
      write,
      sessionId,
    }),
  });
  if (!r.ok) {
    console.error("web.authorize.denied", { status: r.status });
    throw Error("Access revoked");
  }
  return r.json();
}
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const response = await fetch(`${env.WEB_API_URL}/internal`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.STAGING_SECRET}`,
          },
          body: JSON.stringify({ action: "pending-canvases" }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw Error("Queue sweep unavailable");
        for (const canvas of (await response.json()).canvases) {
          await env.ROOM.get(env.ROOM.idFromName(canvas)).fetch(
            new Request("https://room/wake", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-kan-room": canvas,
              },
              body: JSON.stringify({ canvas }),
            }),
          );
        }
      })(),
    );
  },
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (
        url.pathname === "/asset" &&
        env.STAGING_SECRET &&
        request.headers.get("authorization") === `Bearer ${env.STAGING_SECRET}`
      ) {
        const key = url.searchParams.get("key");
        if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key || ""))
          return new Response("Invalid asset", { status: 400 });
        if (request.method === "PUT") {
          await env.ASSETS.put(key, request.body, {
            httpMetadata: { contentType: request.headers.get("content-type") },
          });
          return Response.json({ stored: true });
        }
        const object = await env.ASSETS.get(key);
        return object
          ? new Response(object.body)
          : new Response("Missing asset", { status: 404 });
      }
      if (
        ["/tool", "/wake"].includes(url.pathname) &&
        env.STAGING_SECRET &&
        request.headers.get("authorization") === `Bearer ${env.STAGING_SECRET}`
      ) {
        const input = await request.clone().json();
        if (!/^[a-f0-9-]{36}$/.test(input.canvas))
          throw Error("Invalid canvas");
        const headers = new Headers(request.headers);
        headers.set("x-kan-room", input.canvas);
        return env.ROOM.get(env.ROOM.idFromName(input.canvas)).fetch(
          new Request(request, { headers }),
        );
      }
      if (url.pathname !== "/sync")
        return new Response("Not found", { status: 404 });
      const [body, signature] = (url.searchParams.get("ticket") || "").split(
        ".",
      );
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.STAGING_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const sig = Uint8Array.from(
        atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          sig,
          new TextEncoder().encode(body),
        ))
      )
        throw Error("Invalid ticket");
      const claims = JSON.parse(
        atob(body.replaceAll("-", "+").replaceAll("_", "/")),
      );
      if (claims.exp <= Date.now() || claims.exp > Date.now() + 90000)
        throw Error("Expired ticket");
      const access = await authorize(
        env,
        claims.room,
        claims.sub,
        false,
        claims.sessionId,
      );
      const headers = new Headers(request.headers);
      headers.set(
        "x-kan-claims",
        JSON.stringify({ ...claims, role: access.role }),
      );
      return env.ROOM.get(env.ROOM.idFromName(claims.room)).fetch(
        new Request(request, { headers }),
      );
    } catch (error) {
      console.error("web.socket.denied", { name: error?.name });
      return new Response("Unauthorized", { status: 401 });
    }
  },
};
export class WebRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tail = Promise.resolve();
    this.coordinator = null;
  }
  queue(fn) {
    const job = this.tail.then(fn);
    this.tail = job.catch(() => {});
    return job;
  }
  async initialize(room) {
    if (this.coordinator) return;
    this.roomId = room;
    this.coordinator = await Coordinator.open(
      new RemotePersistence(this.env.WEB_API_URL, this.env.STAGING_SECRET),
      room,
      {
        schema,
        roomOptions: {
          clientTimeout: Infinity,
          onSessionSnapshot: (id, snapshot) => {
            const ws = this.ctx
              .getWebSockets()
              .find((ws) => ws.deserializeAttachment()?.id === id);
            if (ws)
              ws.serializeAttachment({
                ...ws.deserializeAttachment(),
                snapshot,
              });
          },
        },
      },
    );
    for (const ws of this.ctx.getWebSockets()) {
      const data = ws.deserializeAttachment();
      if (!data?.snapshot) {
        ws.close(1012, "Reconnect");
        continue;
      }
      try {
        await this.check(data);
        this.coordinator.sockets.add(ws);
        this.coordinator.room.handleSocketResume({
          sessionId: data.id,
          snapshot: data.snapshot,
          socket: this.wrap(ws),
        });
      } catch {
        ws.close(1008, "Access expired");
      }
    }
  }
  wrap(ws) {
    const c = this.coordinator;
    return {
      get readyState() {
        return ws.readyState;
      },
      send: (data) => {
        if (c.pending) c.outbound.push(() => ws.send(data));
        else ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
  }
  async check(data) {
    if (data.exp <= Date.now()) throw Error("Session ticket expired");
    const access = await authorize(
      this.env,
      data.room,
      data.sub,
      false,
      data.sessionId,
    );
    if (access.role !== data.role) throw Error("Role changed");
  }
  async fetch(request) {
    let stage = "start";
    return this.queue(async () => {
      const path = new URL(request.url).pathname;
      if (path === "/wake" || path === "/tool") {
        const input = await request.json();
        await this.initialize(request.headers.get("x-kan-room"));
        if (path === "/wake") {
          await this.ctx.storage.put("queueRoom", this.roomId);
          await this.ctx.storage.setAlarm(Date.now() + 100);
          return Response.json({ queued: true });
        }
        await authorize(this.env, this.roomId, input.user, true);
        if (input.name === "getCanvas") {
          const plan = planTool(this.coordinator.room, schema, input);
          return Response.json({
            ...plan.result,
            revision: this.coordinator.revision,
          });
        }
        const prior = await this.coordinator.persistence.receipt(
          this.roomId,
          input.operation,
          {
            name: input.name,
            input: input.input,
            actor: { user: input.user, run: input.run, session: input.session },
          },
        );
        if (prior)
          return Response.json({
            duplicate: true,
            revision: this.coordinator.revision,
            committedRevision: prior.revision,
            shapeIds: prior.changes.puts
              .filter((doc) => doc.state.typeName === "shape")
              .map((doc) => doc.state.id),
            removed: prior.changes.removes,
          });
        if (input.expectedRevision !== this.coordinator.revision)
          return Response.json(
            { error: "Stale agent revision; read canvas again" },
            { status: 409 },
          );
        const plan = planTool(this.coordinator.room, schema, input);
        await this.coordinator.transact(
          input.operation,
          {
            name: input.name,
            input: input.input,
            actor: { user: input.user, run: input.run, session: input.session },
          },
          (room) => {
            if (input.expectedRevision !== this.coordinator.revision)
              throw Error("Stale agent revision");
            return room.updateStore((store) => {
              plan.removes.forEach((id) => store.delete(id));
              plan.puts.forEach((record) => store.put(record));
            });
          },
          true,
        );
        return Response.json({
          ...plan.result,
          revision: this.coordinator.revision,
        });
      }
      stage = "claims";
      const claims = JSON.parse(request.headers.get("x-kan-claims"));
      stage = "initialize";
      await this.initialize(claims.room);
      stage = "socket-pair";
      const [client, server] = Object.values(new WebSocketPair());
      const data = { ...claims, id: crypto.randomUUID() };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(data);
      stage = "connect";
      await this.coordinator.connect(data.id, server, data.role === "viewer");
      stage = "alarm";
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return new Response(null, { status: 101, webSocket: client });
    }).catch((error) => {
      const known = ["Access revoked", "Write access revoked", "Fenced coordinator", "Run cancelled or replaced"];
      console.error("web.room.rejected", { name: error?.name, reason: known.includes(error?.message) ? error.message : "initialization-or-validation" });
      if (this.coordinator?.dead) this.ctx.abort("Discard failed cache");
      return Response.json(
        { error: "Canvas operation rejected", diagnostic: { stage, name: error?.name } },
        { status: 409 },
      );
    });
  }
  async webSocketMessage(ws, message) {
    return this.queue(async () => {
      const data = ws.deserializeAttachment();
      try {
        await this.initialize(data.room);
        await this.check(data);
        if (typeof message !== "string" || message.length > 2 * 1024 * 1024)
          throw Error("Frame too large");
        if (message === '{"type":"ping"}') {
          ws.send('{"type":"pong"}');
          return;
        }
        await this.coordinator.receive(data.id, message, { user: data.sub });
        for (const peer of this.ctx.getWebSockets()) {
          const d = peer.deserializeAttachment(),
            snapshot = this.coordinator.room.getSessionSnapshot(d.id);
          if (snapshot) peer.serializeAttachment({ ...d, snapshot });
        }
      } catch {
        ws.close(1008, "Access expired or commit rejected");
        if (this.coordinator?.dead) this.ctx.abort("Discard failed cache");
      }
    });
  }
  async webSocketClose(ws) {
    this.coordinator?.sockets.delete(ws);
    return this.queue(() =>
      this.coordinator?.room.handleSocketClose(ws.deserializeAttachment().id),
    );
  }
  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
  async alarm() {
    const room = await this.ctx.storage.get("queueRoom");
    let pending = false;
    if (room) {
      try {
        const r = await fetch(`${this.env.WEB_API_URL}/internal`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.env.STAGING_SECRET}`,
          },
          body: JSON.stringify({ action: "dispatch", canvas: room }),
        });
        pending = !r.ok || (await r.json()).pending;
      } catch {
        pending = true;
      }
    }
    for (const ws of this.ctx.getWebSockets())
      try {
        await this.check(ws.deserializeAttachment());
      } catch {
        ws.close(1008, "Access expired");
      }
    if (pending || this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + (pending ? 3000 : 30000));
  }
}

// Preserve the previous namespace without deleting its fixture data. The legacy
// spike transport is no longer served by the maintained application's router.
export class StagingRoom extends DurableObject {
  async fetch() {
    return new Response("M0 fixture transport retired; data retained", {
      status: 410,
    });
  }
}
