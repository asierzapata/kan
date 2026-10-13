function integer(name: string, raw: string) {
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be an integer >= 0`);
  return Number(raw);
}
export function runCeiling(env: Record<string, string | undefined> = process.env) {
  const raw = env.KAN_RUN_CEILING;
  if (raw !== undefined && raw.trim() !== "") return integer("KAN_RUN_CEILING", raw);
  if (env.KAN_ENV === "production")
    throw new Error("KAN_RUN_CEILING must be set in production (0 = unlimited)");
  return 20;
}
export const runCeilingReached = (count: number) => {
  const ceiling = runCeiling();
  return ceiling > 0 && count >= ceiling;
};
export function contextRunCap(env: Record<string, string | undefined> = process.env) {
  const raw = env.KAN_CONTEXT_RUN_CAP;
  return raw !== undefined && raw.trim() !== ""
    ? integer("KAN_CONTEXT_RUN_CAP", raw)
    : 20;
}
