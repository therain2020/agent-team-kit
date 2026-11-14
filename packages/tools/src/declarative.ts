import { spawn } from "node:child_process";
import type { PackTool } from "@kit/core";
import { callMcpTool } from "./mcp";
import { truncate } from "./paths";
import type { Tool, ToolResult } from "./types";
import { assertUrlAllowed } from "./web-tools";

const MAX_RESPONSE_CHARS = 40_000;
const MAX_COMMAND_OUTPUT = 1_000_000;
const COMMAND_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
];

export interface DeclarativeToolOptions {
  allowCommand?: boolean;
}

export function createDeclarativeTools(
  specs: PackTool[],
  options: DeclarativeToolOptions = {},
): Tool[] {
  return specs.flatMap((spec) => {
    if (spec.adapter === "command") {
      return options.allowCommand ? [commandTool(spec, options)] : [];
    }
    return [spec.adapter === "mcp" ? mcpTool(spec) : httpTool(spec)];
  });
}

function httpTool(spec: PackTool): Tool {
  const endpoint = spec.endpoint;
  if (!endpoint) {
    throw new Error(`tool ${spec.name} has no endpoint`);
  }

  return {
    definition: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      risk: spec.risk,
    },
    async execute(args, context) {
      await assertUrlAllowed(endpoint, context);
      const url = new URL(endpoint);
      const headers: Record<string, string> = {
        "user-agent": "agent-team-kit/0.9",
        ...(spec.headers ?? {}),
      };
      let body: string | undefined;

      if (spec.method === "GET") {
        for (const [key, value] of Object.entries(args)) {
          if (value === undefined || value === null) {
            continue;
          }
          url.searchParams.set(
            key,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
        }
      } else {
        body = JSON.stringify(args);
        headers["content-type"] = "application/json";
      }

      const response = await fetch(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(spec.timeoutMs),
      });
      const text = await response.text();

      return {
        content: truncate(
          `HTTP ${response.status} ${response.statusText}\ncontent-type: ${response.headers.get("content-type") ?? "unknown"}\n\n${text}`,
          MAX_RESPONSE_CHARS,
        ),
        isError: !response.ok,
        metadata: { adapter: "http", status: response.status },
      };
    },
  };
}

function mcpTool(spec: PackTool): Tool {
  const endpoint = spec.endpoint;
  if (!endpoint) {
    throw new Error(`tool ${spec.name} has no endpoint`);
  }

  return {
    definition: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      risk: spec.risk,
    },
    async execute(args, context) {
      await assertUrlAllowed(endpoint, context);
      const result = await callMcpTool({
        endpoint,
        toolName: spec.toolName ?? spec.name,
        args,
        headers: spec.headers,
        timeoutMs: spec.timeoutMs,
      });
      return {
        content: result.content,
        isError: result.isError,
        metadata: { adapter: "mcp" },
      };
    },
  };
}

function commandTool(spec: PackTool, options: DeclarativeToolOptions): Tool {
  const command = spec.command;
  if (!command || command.length === 0) {
    throw new Error(`tool ${spec.name} has no command`);
  }
  const [file, ...argv] = command;
  if (!file) {
    throw new Error(`tool ${spec.name} has no executable`);
  }

  return {
    definition: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      risk: spec.risk,
    },
    async execute(args, context): Promise<ToolResult> {
      if (!options.allowCommand) {
        throw new Error(
          `command tool ${spec.name} requires explicit consent (KIT_TOOLS_ALLOW_COMMAND=1)`,
        );
      }
      if (context.runMode !== "LIVE") {
        throw new Error(
          `command tool ${spec.name} is only available in LIVE mode`,
        );
      }

      const result = await runCommand(
        file,
        argv,
        JSON.stringify(args),
        context.sandboxRoot,
        spec.timeoutMs,
      );
      return {
        content: truncate(result.output, MAX_RESPONSE_CHARS),
        isError: result.timedOut || result.code !== 0,
        metadata: {
          adapter: "command",
          exitCode: result.code,
          timedOut: result.timedOut,
        },
      };
    },
  };
}

function runCommand(
  file: string,
  argv: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd,
      // Next augments NodeJS.ProcessEnv with a required NODE_ENV; the cleaned env omits it.
      env: sanitizedEnv() as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const collect = (chunk: Buffer, target: "out" | "err") => {
      if (bytes >= MAX_COMMAND_OUTPUT) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8").slice(0, MAX_COMMAND_OUTPUT - bytes);
      bytes += Buffer.byteLength(text, "utf8");
      if (target === "out") {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "err"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const suffix = `${timedOut ? "\n[command timed out]" : ""}${truncated ? "\n[output truncated]" : ""}`;
      resolve({
        code,
        output: `exit ${code ?? "signal"}\n${stdout}${stderr}${suffix}`,
        timedOut,
      });
    });

    child.stdin?.end(input);
  });
}

function sanitizedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of COMMAND_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
