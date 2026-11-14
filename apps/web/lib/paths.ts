import path from "node:path";

export function getRepoRoot(): string {
  const cwd = process.cwd();
  const isWebApp =
    path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps";
  return isWebApp ? path.resolve(cwd, "../..") : cwd;
}

export function getPacksRoot(): string {
  return path.join(getRepoRoot(), "packs");
}

export function resolvePackDir(input: string): string | null {
  return resolveNamedDir("packs", input);
}

export function resolveVariantDir(input: string): string | null {
  return resolveNamedDir("variants", input);
}

function resolveNamedDir(rootName: string, input: string): string | null {
  const name = path.basename(input);
  if (!name || name !== input || name === "." || name === "..") {
    return null;
  }
  const root = path.join(getRepoRoot(), rootName);
  const resolved = path.resolve(root, name);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    return null;
  }
  return resolved;
}
