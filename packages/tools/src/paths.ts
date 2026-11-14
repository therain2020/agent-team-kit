import path from "node:path";

export const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  ".tmp",
  "dist",
  "variants",
  "logs",
  ".gstack",
]);

export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`path escapes the allowed root: ${relative}`);
  }
  return target;
}

export function relativeInside(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function truncate(value: string, max = 30_000): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}

export function argString(
  args: Record<string, unknown>,
  key: string,
  required = true,
): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!required) {
    return "";
  }
  throw new Error(`missing string argument: ${key}`);
}

export function argNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
