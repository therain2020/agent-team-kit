import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bootstrapSecretsPath } from "./paths";

const DPAPI_PROTECT = [
  "$key = [Console]::In.ReadToEnd().Trim()",
  "$sec = ConvertTo-SecureString $key -AsPlainText -Force",
  "ConvertFrom-SecureString $sec",
].join("; ");

const DPAPI_UNPROTECT = [
  "$enc = [Console]::In.ReadToEnd().Trim()",
  "$sec = ConvertTo-SecureString $enc",
  "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)",
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)",
].join("; ");

interface SecretsFile {
  backend: "dpapi" | "file";
  value: string;
}

const cache = new Map<string, string | null>();

export function loadApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.DEEPSEEK_API_KEY) {
    return env.DEEPSEEK_API_KEY;
  }

  const file = bootstrapSecretsPath(env);
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const key = readSecrets(file);
  cache.set(file, key);
  return key ?? undefined;
}

export function hasApiKey(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(loadApiKey(env));
}

export async function saveApiKey(
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ path: string; backend: SecretsFile["backend"] }> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("api key is empty");
  }
  const file = bootstrapSecretsPath(env);
  await mkdir(path.dirname(file), { recursive: true });

  const secrets = protectKey(key);
  await writeFile(file, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  cache.set(file, key);
  return { path: file, backend: secrets.backend };
}

export async function clearApiKey(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const file = bootstrapSecretsPath(env);
  cache.set(file, null);
  await rm(file, { force: true });
}

function readSecrets(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<SecretsFile>;
    if (parsed.backend === "dpapi" && parsed.value) {
      if (process.platform !== "win32") {
        return null;
      }
      return unprotectKey(parsed.value);
    }
    if (parsed.backend === "file" && parsed.value) {
      return parsed.value;
    }
    return null;
  } catch {
    return null;
  }
}

function protectKey(key: string): SecretsFile {
  if (process.platform === "win32") {
    try {
      const value = runPowerShell(DPAPI_PROTECT, key);
      if (value) {
        return { backend: "dpapi", value };
      }
    } catch {
      // fall through to the plaintext local file
    }
  }
  return { backend: "file", value: key };
}

function unprotectKey(value: string): string | null {
  try {
    return runPowerShell(DPAPI_UNPROTECT, value) || null;
  } catch {
    return null;
  }
}

function runPowerShell(script: string, input: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", timeout: 30_000 },
  ).trim();
}
