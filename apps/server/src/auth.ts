import { betterAuth } from "better-auth";
import { sql, type Kysely } from "kysely";
import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}
export interface Auth {
  user: AuthUser;
  sessionId: string;
}

export interface AuthService {
  handler?(request: Request): Promise<Response>;
  activeAuth(request: Request): Promise<Auth>;
  assertActiveSession?(userId: string, sessionId: string): Promise<void>;
}

export interface ServerAuth extends AuthService {
  handler(request: Request): Promise<Response>;
  assertActiveSession(userId: string, sessionId: string): Promise<void>;
  api: ReturnType<typeof betterAuth>["api"];
}

export function createAuth(
  config: Pick<Config, "KAN_PUBLIC_URL" | "BETTER_AUTH_SECRET">,
  kysely: Kysely<any>,
): ServerAuth {
  const auth = betterAuth({
    baseURL: config.KAN_PUBLIC_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.KAN_PUBLIC_URL],
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
    database: { db: kysely, type: "postgres" },
  });

  const activeSessions = new Map<string, { until: number }>();
  // Sessions are local rows; the short cache bounds the check on busy sockets.
  async function assertActiveSession(userId: string, sessionId: string) {
    if (!sessionId) throw new HttpError(401, "Session expired");
    const key = `${userId}:${sessionId}`,
      cached = activeSessions.get(key);
    if (cached && cached.until > Date.now()) return;
    const result = await sql<{ expiresAt: Date }>`
      SELECT "expiresAt" FROM "session" WHERE id=${sessionId} AND "userId"=${userId} AND "expiresAt" > now()
    `.execute(kysely);
    const row = result.rows[0];
    if (!row) throw new HttpError(401, "Session expired or revoked");
    if (activeSessions.size >= 512) activeSessions.delete(activeSessions.keys().next().value!);
    activeSessions.set(key, {
      until: Math.min(Date.now() + 30000, new Date(row.expiresAt).getTime()),
    });
  }

  async function activeAuth(request: Request): Promise<Auth> {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session) throw new HttpError(401, "Your session expired. Sign in to continue.");
    await assertActiveSession(session.user.id, session.session.id);
    const { id, email, name } = session.user;
    return { user: { id, email, name }, sessionId: session.session.id };
  }

  return { handler: (request) => auth.handler(request), activeAuth, assertActiveSession, api: auth.api };
}
