import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.ts";

export interface AssetStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream | Buffer; contentType: string } | null>;
}

const KEY = /^[a-f0-9-]{36}\/[a-f0-9-]{36}$/;
const assertKey = (key: string) => {
  if (!KEY.test(key)) throw new Error("Invalid asset key");
};

export function localAssetStore(dir: string): AssetStore {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    assertKey(key);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error("Invalid asset key");
    return path;
  };
  return {
    async put(key, bytes, contentType) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await writeFile(`${path}.type`, contentType);
    },
    async get(key) {
      const path = pathOf(key);
      try {
        const [body, contentType] = await Promise.all([
          readFile(path),
          readFile(`${path}.type`, "utf8").catch(() => "application/octet-stream"),
        ]);
        return { body, contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export function s3AssetStore(config: Config): AssetStore {
  const bucket = config.S3_BUCKET!;
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials:
      config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  return {
    async put(key, bytes, contentType) {
      assertKey(key);
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }),
      );
    },
    async get(key) {
      assertKey(key);
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!object.Body) return null;
        return {
          body: object.Body.transformToWebStream() as ReadableStream,
          contentType: object.ContentType ?? "application/octet-stream",
        };
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
  };
}

export function createAssetStore(
  config: Config,
  log: Pick<Console, "info"> = console,
): AssetStore {
  if (config.S3_BUCKET) return s3AssetStore(config);
  if (config.KAN_ENV !== "development")
    throw new Error("S3_BUCKET is required outside development");
  const dir = join(config.KAN_DATA_DIR, "assets");
  log.info("server.assets_local", { dir });
  return localAssetStore(dir);
}
