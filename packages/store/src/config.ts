import os from "node:os";
import path from "node:path";

export type BlobBackend = "s3" | "fs";
export type StoreDriver = "postgres" | "pglite";

export interface StoreConfig {
  driver: StoreDriver;
  dataDir: string;
  dbUrl: string;
  blobBackend: BlobBackend;
  blobRoot: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
}

export function loadStoreConfig(
  env: Record<string, string | undefined> = process.env,
): StoreConfig {
  const home = env.KIT_HOME
    ? path.resolve(env.KIT_HOME)
    : path.join(os.homedir(), ".agent-team-kit");
  const driver: StoreDriver =
    env.KIT_DB_DRIVER === "pglite" || env.KIT_RUNTIME_MODE === "local"
      ? "pglite"
      : "postgres";

  return {
    driver,
    dataDir: env.KIT_DATA_DIR ?? path.join(home, "data"),
    dbUrl: env.KIT_DB_URL ?? "postgres://kit:kit@localhost:5432/kit",
    blobBackend: env.KIT_BLOB_BACKEND === "s3" ? "s3" : "fs",
    blobRoot: env.KIT_BLOB_ROOT ?? ".tmp/blobs",
    s3Endpoint: env.KIT_S3_ENDPOINT ?? "http://localhost:9000",
    s3Region: env.KIT_S3_REGION ?? "us-east-1",
    s3AccessKey: env.KIT_S3_ACCESS_KEY ?? "kit",
    s3SecretKey: env.KIT_S3_SECRET_KEY ?? "kitkitkit",
    s3Bucket: env.KIT_S3_BUCKET ?? "kit",
  };
}
