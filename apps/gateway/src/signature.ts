import { createHmac, timingSafeEqual } from "node:crypto";

export function signHmac(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyHmac(
  secret: string | undefined,
  body: string,
  header: string | null,
  options: { prefix?: string } = {},
): boolean {
  if (!secret || !header) {
    return false;
  }
  const prefix = options.prefix ?? "sha256=";
  const provided = header.startsWith(prefix)
    ? header.slice(prefix.length)
    : header;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(provided, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

export function isFreshTimestamp(
  header: string | null,
  now = Date.now(),
  toleranceMs = 5 * 60 * 1000,
): boolean {
  if (!header) {
    return true;
  }
  const value = Number(header);
  if (!Number.isFinite(value)) {
    return false;
  }
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return Math.abs(now - timestamp) <= toleranceMs;
}
