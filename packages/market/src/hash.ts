import { createHash } from "node:crypto";

/** Lower-case hex SHA-256 of a string or buffer (manifest/content pinning). */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
