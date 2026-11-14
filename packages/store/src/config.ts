export type BlobBackend = "s3" | "fs";

export interface StoreConfig {
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
  return {
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
