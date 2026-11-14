import { spawn, spawnSync } from "node:child_process";

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: boolean;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

export function commandOnPath(command: string): string | null {
  const probe = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", windowsHide: true },
  );
  if (probe.status !== 0) {
    return null;
  }
  const candidates = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (process.platform !== "win32") {
    return candidates[0] ?? null;
  }
  const priority = [".exe", ".cmd", ".bat"];
  for (const extension of priority) {
    const match = candidates.find((candidate) =>
      candidate.toLowerCase().endsWith(extension),
    );
    if (match) {
      return match;
    }
  }
  return candidates[0] ?? null;
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const needsShell =
    options.shell ??
    (process.platform === "win32" &&
      /\.(cmd|bat)$/i.test(command) &&
      !/\.exe$/i.test(command));

  return await new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        truncated,
        ...(error ? { error } : {}),
      });
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(child);
      },
      Math.max(1000, options.timeoutMs ?? 20 * 60 * 1000),
    );

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length >= maxOutput) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutput) {
        stdout = `${stdout.slice(0, maxOutput)}\n[truncated]`;
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= maxOutput) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
      if (stderr.length > maxOutput) {
        stderr = `${stderr.slice(0, maxOutput)}\n[truncated]`;
        truncated = true;
      }
    });

    child.on("error", (error) => {
      finish(null, error.message);
    });

    child.on("exit", (code) => {
      finish(code);
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // process may already be gone
  }
}

const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemDrive",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "CommonProgramFiles",
  "CommonProgramW6432",
  "PSModulePath",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "USERNAME",
  "USERDOMAIN",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DSH_HOME",
];

export function scrubbedEnv(extra: string[] = []): NodeJS.ProcessEnv {
  const keep = new Set([...BASE_ENV_KEYS, ...extra]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => keep.has(key)),
  ) as NodeJS.ProcessEnv;
}
