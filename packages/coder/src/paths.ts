import os from "node:os";
import path from "node:path";

const DEFAULT_BASE = "agent-team-kit";

export function coderSandboxBase(): string {
  const configured = process.env.KIT_CODER_SANDBOX_ROOT;
  return configured
    ? path.resolve(configured)
    : path.join(os.tmpdir(), DEFAULT_BASE);
}

export function coderSandboxRoot(...parts: string[]): string {
  return path.join(coderSandboxBase(), ...parts);
}

export function isCoderSandboxPath(value: string): boolean {
  const resolved = path.resolve(value);
  const base = coderSandboxBase();
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}
