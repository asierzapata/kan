import { WorkOS } from "@workos-inc/node";
import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";

export const SESSION_COOKIE = "wos-session";
const MAX_AGE = 400 * 24 * 60 * 60;

const clients = new Map<string, WorkOS>();
function workos(config: Pick<Config, "WORKOS_API_KEY" | "WORKOS_CLIENT_ID">) {
  const key = `${config.WORKOS_API_KEY}:${config.WORKOS_CLIENT_ID}`;
  let client = clients.get(key);
  if (!client) {
    client = new WorkOS(config.WORKOS_API_KEY, { clientId: config.WORKOS_CLIENT_ID });
    clients.set(key, client);
  }
  return client;
}

export const encodeState = (returnPathname: string) =>
  Buffer.from(JSON.stringify({ returnPathname })).toString("base64url");

export function decodeState(state: string | null | undefined) {
  try {
    const parsed = JSON.parse(Buffer.from(state ?? "", "base64url").toString("utf8"));
    const path = parsed?.returnPathname;
    if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) return path;
  } catch {}
  return "/";
}

export function signInUrl(config: Config, returnPathname: string) {
  return workos(config).userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: config.WORKOS_CLIENT_ID,
    redirectUri: `${config.KAN_PUBLIC_URL}/api/auth/callback`,
    state: encodeState(returnPathname),
  });
}

export async function handleCallback(config: Config, code: string, state?: string | null) {
  const result = await workos(config).userManagement.authenticateWithCode({
    clientId: config.WORKOS_CLIENT_ID,
    code,
    session: { sealSession: true, cookiePassword: config.WORKOS_COOKIE_PASSWORD },
  });
  if (!result.sealedSession) throw new HttpError(502, "Sign-in did not return a session");
  return { sealedSession: result.sealedSession, returnPathname: decodeState(state) };
}

export function sessionCookie(config: Pick<Config, "KAN_PUBLIC_URL">, value: string) {
  return cookie(config, encodeURIComponent(value), MAX_AGE);
}
export function clearSessionCookie(config: Pick<Config, "KAN_PUBLIC_URL">) {
  return cookie(config, "", 0);
}
function cookie(config: Pick<Config, "KAN_PUBLIC_URL">, value: string, maxAge: number) {
  const secure = config.KAN_PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function readCookie(header: string | null | undefined, name = SESSION_COOKIE) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}
export interface Auth {
  user: AuthUser;
  sessionId: string;
  setCookie?: string;
}

export async function readAuth(config: Config, cookieHeader: string | null | undefined): Promise<Auth | null> {
  const sessionData = readCookie(cookieHeader);
  if (!sessionData) return null;
  const session = workos(config).userManagement.loadSealedSession({
    sessionData,
    cookiePassword: config.WORKOS_COOKIE_PASSWORD,
  });
  try {
    const current = await session.authenticate();
    if (current.authenticated)
      return { user: current.user, sessionId: current.sessionId };
    const refreshed = await session.refresh({ cookiePassword: config.WORKOS_COOKIE_PASSWORD });
    if (!refreshed.authenticated) return null;
    return {
      user: refreshed.user,
      sessionId: refreshed.sessionId,
      setCookie: refreshed.sealedSession ? sessionCookie(config, refreshed.sealedSession) : undefined,
    };
  } catch {
    return null;
  }
}

export async function logoutUrl(config: Config, cookieHeader: string | null | undefined) {
  const sessionData = readCookie(cookieHeader);
  if (!sessionData) return null;
  try {
    return await workos(config)
      .userManagement.loadSealedSession({ sessionData, cookiePassword: config.WORKOS_COOKIE_PASSWORD })
      .getLogoutUrl({ returnTo: config.KAN_PUBLIC_URL });
  } catch {
    return null;
  }
}

const activeSessions = new Map<string, { until: number }>();
// WorkOS JWTs remain valid briefly after remote revocation. Bound that window
// explicitly for HTTP and active sockets instead of relying on token expiry.
export async function assertActiveSession(
  config: Pick<Config, "WORKOS_API_KEY" | "WORKOS_CLIENT_ID">,
  userId: string,
  sessionId: string,
) {
  if (!sessionId) throw new HttpError(401, "Session expired");
  const key = `${userId}:${sessionId}`,
    cached = activeSessions.get(key);
  if (cached && cached.until > Date.now()) return;
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const sessions = await workos(config).userManagement.listSessions(userId, {
      limit: 100,
      after,
    });
    const session = sessions.data.find((session) => session.id === sessionId);
    if (session) {
      if (
        session.status !== "active" ||
        Date.parse(session.expiresAt) <= Date.now()
      )
        throw new HttpError(401, "Session expired or revoked");
      if (activeSessions.size >= 512)
        activeSessions.delete(activeSessions.keys().next().value!);
      activeSessions.set(key, {
        until: Math.min(Date.now() + 30000, Date.parse(session.expiresAt)),
      });
      return;
    }
    after = sessions.listMetadata.after ?? undefined;
    if (!after) break;
  }
  throw new HttpError(401, "Session expired or revoked");
}

export async function activeAuth(config: Config, request: Request): Promise<Auth> {
  const auth = await readAuth(config, request.headers.get("cookie"));
  if (!auth) throw new HttpError(401, "Your session expired. Sign in to continue.");
  await assertActiveSession(config, auth.user.id, auth.sessionId);
  return auth;
}
