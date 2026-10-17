import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { RoomManager } from "./rooms.ts";
import { verifyTicket, type TicketClaims } from "./tickets.ts";

export interface SyncOptions {
  rooms: RoomManager;
  secret: string;
  allowedOrigin: string;
  authorize: (claims: TicketClaims) => Promise<{ role: string }>;
}

export function attachSync(server: Server, opts: SyncOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", async (req, socket, head) => {
    const deny = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const reject = () => deny("401 Unauthorized");
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/sync") return reject();
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== opts.allowedOrigin) return reject();
      const claims = verifyTicket(opts.secret, url.searchParams.get("ticket") ?? "");
      const access = await opts.authorize(claims);
      if (access.role !== claims.role) return reject();
      try {
        await opts.rooms.open(claims.room);
      } catch {
        return deny("503 Service Unavailable");
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        opts.rooms
          .connect(claims.room, ws, {
            sessionId: `sync_${crypto.randomUUID()}`,
            userId: claims.sub,
            authSessionId: claims.sessionId,
            role: claims.role,
          })
          .catch(() => ws.close(1011, "Room unavailable"));
      });
    } catch (error) {
      console.error("server.socket_denied", { name: (error as Error)?.name });
      reject();
    }
  });
  return {
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
