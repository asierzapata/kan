import { getAuth } from "@workos/authkit-tanstack-react-start";
import { WorkOS } from "@workos-inc/node";
import { HttpError } from "./access";
const activeSessions = new Map<string, { until: number }>();
// WorkOS JWTs remain valid briefly after remote revocation. Bound that window
// explicitly for HTTP and active sockets instead of relying on token expiry.
export async function assertActiveSession(userId: string, sessionId: string) {
  if (!sessionId) throw new HttpError(401, "Session expired");
  const key = `${userId}:${sessionId}`,
    cached = activeSessions.get(key);
  if (cached && cached.until > Date.now()) return;
  const workos = new WorkOS(process.env.WORKOS_API_KEY, {
    clientId: process.env.WORKOS_CLIENT_ID,
  });
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const sessions = await workos.userManagement.listSessions(userId, {
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
export async function activeAuth() {
  const auth = await getAuth();
  if (!auth.user)
    throw new HttpError(401, "Your session expired. Sign in to continue.");
  await assertActiveSession(auth.user.id, auth.sessionId);
  return auth;
}
