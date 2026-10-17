import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  KAN_DATA_DIR: z.string().min(1).default(join(root, "data", "server")),
  DATABASE_URL: z.string().min(1).optional(),
  KAN_ENV: z.enum(["development", "staging", "production"]).default("development"),
  KAN_SERVICE_SECRET: z.string().min(16),
  KAN_PUBLIC_URL: z.string().url().default("http://localhost:1430"),
  BETTER_AUTH_SECRET: z.string().min(32),
  EVE_URL: z.string().min(1).optional(),
  KAN_RUN_CEILING: z.string().optional(),
  KAN_CONTEXT_RUN_CAP: z.string().optional(),
  KAN_WEB_DIST: z.string().min(1).default(join(root, "apps", "web", "dist")),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
}).superRefine((config, ctx) => {
  if (config.KAN_ENV === "development") return;
  if (!config.EVE_URL)
    ctx.addIssue({ code: "custom", path: ["EVE_URL"], message: "EVE_URL is required outside development" });
  if (!config.S3_BUCKET)
    ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "S3_BUCKET is required outside development" });
});

export type Config = z.infer<typeof schema>;

export function loadEnvFile() {
  const file = join(root, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadEnvFile();
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  return schema.parse(clean);
}
