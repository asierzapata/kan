import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const roles = { viewer: 0, editor: 1, owner: 2 } as const;
export async function workspaceAccess(
  tx: any,
  workspace: string,
  user: string,
  minimum: keyof typeof roles = "viewer",
) {
  const row = (
    await tx.query(
      "SELECT role FROM web_memberships WHERE workspace=$1 AND user_id=$2",
      [workspace, user],
    )
  ).rows[0];
  if (!row || roles[row.role as keyof typeof roles] < roles[minimum])
    throw new HttpError(403, "Workspace access denied");
  return row.role as keyof typeof roles;
}
export async function canvasAccess(
  tx: any,
  canvas: string,
  user: string,
  minimum: keyof typeof roles = "viewer",
) {
  const row = (
    await tx.query(
      "SELECT * FROM web_canvases WHERE id=$1 AND deleted_at IS NULL",
      [canvas],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Canvas unavailable");
  const role = await workspaceAccess(tx, row.workspace, user, minimum);
  return { ...row, role };
}
export function text(value: unknown, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, "Invalid text");
  return value.trim();
}
