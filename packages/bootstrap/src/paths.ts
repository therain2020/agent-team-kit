import os from "node:os";
import path from "node:path";

export function bootstrapHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.KIT_HOME
    ? path.resolve(env.KIT_HOME)
    : path.join(os.homedir(), ".agent-team-kit");
}

export function bootstrapProfilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(bootstrapHome(env), "bootstrap.json");
}

export function bootstrapSecretsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(bootstrapHome(env), "secrets.json");
}
