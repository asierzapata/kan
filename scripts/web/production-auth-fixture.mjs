import { writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { WorkOS } from "@workos-inc/node";
import { production, config, artifact, authEnvironment } from "./acceptance-config.mjs";

if (!production) throw Error("Set KAN_ACCEPTANCE_CONFIG to the private production config");
authEnvironment();
const workos = new WorkOS(process.env.WORKOS_API_KEY, { clientId: process.env.WORKOS_CLIENT_ID });
const accounts = [];
const users = [];
for (const role of ["owner", "viewer"]) {
  const password = randomBytes(32).toString("base64url") + "A9!";
  const email = `kan-prod-qa-${role}-${randomUUID()}@example.test`;
  const user = await workos.userManagement.createUser({ email, password, emailVerified: true, firstName: "Synthetic", lastName: "QA" });
  users.push({ userId: user.id, email, password });
  // Persist each created account immediately so interrupted setup can be cleaned up.
  await writeFile(artifact("qa-users"), JSON.stringify(users), { mode: 0o600 });
  const result = await workos.userManagement.authenticateWithPassword({ clientId: process.env.WORKOS_CLIENT_ID, email, password, session: { sealSession: true, cookiePassword: config.cookiePassword } });
  if (!result.sealedSession) throw Error("Session seal unavailable");
  accounts.push({ id: user.id, email, cookie: `wos-session=${encodeURIComponent(result.sealedSession)}` });
}
await writeFile(artifact("qa-user"), JSON.stringify(users[0]), { mode: 0o600 });
await writeFile(artifact("qa-sessions"), JSON.stringify(accounts), { mode: 0o600 });
console.log("Created two disposable production WorkOS QA accounts and sealed sessions; values remain private.");
