import { createHmac, timingSafeEqual } from "node:crypto";

export interface TicketClaims {
  room: string;
  sub: string;
  sessionId: string;
  role: "owner" | "editor" | "viewer";
  exp: number;
}

const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("base64url");

export function issueTicket(secret: string, claims: TicketClaims) {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyTicket(secret: string, ticket: string, now = Date.now()): TicketClaims {
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined) throw new Error("Invalid ticket");
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("Invalid ticket");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketClaims;
  if (typeof claims.exp !== "number" || claims.exp <= now || claims.exp > now + 90_000)
    throw new Error("Expired ticket");
  return claims;
}
