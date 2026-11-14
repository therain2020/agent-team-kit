import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import {
  SKIP_DIRS,
  argNumber,
  argString,
  relativeInside,
  resolveInside,
  truncate,
} from "./paths";
import type { Tool, ToolContext, ToolResult } from "./types";

const execFileAsync = promisify(execFile);
const MAX_READ = 200_000;
const MAX_OUTPUT = 30_000;
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".css",
  ".html",
  ".sql",
  ".toml",
  ".env",
  ".txt",
]);

export const repoListTool: Tool = {
  definition: {
    name: "repo_list",
    description: "List files and directories inside the repository.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative directory (default '.')",
        },
      },
    },
  },
  async execute(args, context) {
    const relative = argString(args, "path", false) || ".";
    const target = resolveInside(context.repoRoot, relative);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows = entries
      .filter((entry) => !SKIP_DIRS.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()))
      .slice(0, 300)
      .map(
        (entry) =>
          `${entry.isDirectory() ? "dir " : "file"} ${entry.name}${entry.isDirectory() ? "/" : ""}`,
      );
    return { content: rows.join("\n") || "(empty)" };
  },
};

export const repoReadTool: Tool = {
  definition: {
    name: "repo_read",
    description:
      "Read a UTF-8 repository file. Optional 1-based line range. Output is capped.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path" },
        startLine: { type: "number", description: "1-based start line" },
        endLine: { type: "number", description: "1-based end line" },
      },
      required: ["path"],
    },
  },
  async execute(args, context) {
    const relative = argString(args, "path");
    const target = resolveInside(context.repoRoot, relative);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${relative}`);
    }
    if (stat.size > MAX_READ) {
      throw new Error(`file exceeds ${MAX_READ} bytes: ${relative}`);
    }
    const text = await fs.readFile(target, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, argNumber(args, "startLine") ?? 1);
    const end = Math.min(
      lines.length,
      argNumber(args, "endLine") ?? lines.length,
    );
    const numbered = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    return {
      content: `# ${relative} (${start}-${end}/${lines.length})\n${truncate(
        numbered,
        MAX_OUTPUT,
      )}`,
    };
  },
};

export const repoSearchTool: Tool = {
  definition: {
    name: "repo_search",
    description:
      "Search repository text files for a literal string. Returns file:line matches.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search" },
        glob: {
          type: "string",
          description: "Optional comma-separated extensions, e.g. ts,tsx",
        },
        maxResults: { type: "number", description: "Default 60, max 200" },
      },
      required: ["query"],
    },
  },
  async execute(args, context) {
    const query = argString(args, "query");
    const max = Math.min(argNumber(args, "maxResults") ?? 60, 200);
    const extensions = argString(args, "glob", false)
      .split(",")
      .map((value) => value.trim().replace(/^\*?\.?/, ""))
      .filter(Boolean)
      .map((value) => `.${value}`);
    const files = await walkFiles(context.repoRoot, 8000);
    const matches: string[] = [];
    for (const relative of files) {
      if (extensions.length > 0) {
        const ext = path.extname(relative);
        if (!extensions.includes(ext)) {
          continue;
        }
      }
      if (!TEXT_EXTENSIONS.has(path.extname(relative))) {
        continue;
      }
      const absolute = resolveInside(context.repoRoot, relative);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_READ) {
        continue;
      }
      const text = await fs.readFile(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]?.toLowerCase().includes(query.toLowerCase())) {
          matches.push(`${relative}:${index + 1}: ${lines[index]?.trim()}`);
          if (matches.length >= max) {
            return { content: matches.join("\n") };
          }
        }
      }
    }
    return { content: matches.join("\n") || "(no matches)" };
  },
};

export const repoDiffTool: Tool = {
  definition: {
    name: "repo_diff",
    description:
      "Show the current git diff and stat for the repository (read-only).",
    risk: "read",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, context) {
    const stat = await run("git", ["diff", "--stat"], context.repoRoot);
    const diff = await run("git", ["diff"], context.repoRoot);
    return {
      content: truncate(
        `git diff --stat\n${stat}\n\ngit diff\n${diff}`,
        40_000,
      ),
    };
  },
};

export const repoTypecheckTool = commandTool(
  "repo_typecheck",
  "Run the repository TypeScript typecheck.",
  ["run", "typecheck"],
);

export const repoLintTool = commandTool(
  "repo_lint",
  "Run the repository Biome lint.",
  ["run", "lint"],
);

export const repoBuildTool = commandTool(
  "repo_build",
  "Run the production web build.",
  ["run", "web:build"],
  240_000,
);

export const repoTestTool: Tool = {
  definition: {
    name: "repo_test",
    description:
      "Run the repository Vitest suite. Optional safe filter string (file or test name).",
    risk: "execute",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional vitest filter, letters/numbers/._:/- only",
        },
      },
    },
  },
  async execute(args, context) {
    const filter = argString(args, "filter", false);
    if (filter && !/^[A-Za-z0-9_.:/-]{1,120}$/.test(filter)) {
      throw new Error("invalid test filter");
    }
    const output = await run(
      "bun",
      ["x", "vitest", "run", ...(filter ? [filter] : [])],
      context.repoRoot,
      180_000,
    );
    return { content: truncate(output, MAX_OUTPUT) };
  },
};

export const workspaceWriteTool: Tool = {
  definition: {
    name: "workspace_write",
    description:
      "Write a proposed file into the run sandbox. This never modifies the real repository; use workspace_diff to inspect the proposal.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative target path",
        },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, context) {
    const relative = argString(args, "path");
    const content = argString(args, "content", false);
    if (content.length > 300_000) {
      throw new Error("workspace_write content exceeds 300KB");
    }
    const target = resolveInside(context.sandboxRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return {
      content: `wrote sandbox file ${relative} (${content.length} chars)`,
      metadata: { path: relative, chars: content.length },
    };
  },
};

export const workspaceDiffTool: Tool = {
  definition: {
    name: "workspace_diff",
    description:
      "Show the unified diff of all files written into the run sandbox versus the repository.",
    risk: "read",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, context) {
    const files = await walkFiles(context.sandboxRoot, 500);
    if (files.length === 0) {
      return { content: "(no sandbox changes)" };
    }
    const patches: string[] = [];
    for (const relative of files) {
      const proposed = await fs.readFile(
        resolveInside(context.sandboxRoot, relative),
        "utf8",
      );
      let original = "";
      try {
        original = await fs.readFile(
          resolveInside(context.repoRoot, relative),
          "utf8",
        );
      } catch {
        original = "";
      }
      patches.push(
        createTwoFilesPatch(
          `a/${relative}`,
          `b/${relative}`,
          original,
          proposed,
          "repository",
          "proposed",
        ),
      );
    }
    return {
      content: truncate(patches.join("\n"), 60_000),
      metadata: { files },
    };
  },
};

function commandTool(
  name: string,
  description: string,
  args: string[],
  timeout = 180_000,
): Tool {
  return {
    definition: {
      name,
      description,
      risk: "execute",
      parameters: { type: "object", properties: {} },
    },
    async execute(_input, context) {
      const output = await run("bun", args, context.repoRoot, timeout);
      return { content: truncate(output, MAX_OUTPUT) };
    },
  };
}

async function run(
  program: string,
  args: string[],
  cwd: string,
  timeout = 180_000,
): Promise<string> {
  try {
    const result = await execFileAsync(program, args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return `${result.stdout}${result.stderr}`.trim() || "(no output)";
  } catch (error) {
    const value = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    const output = `${value.stdout ?? ""}${value.stderr ?? ""}`.trim();
    throw new ToolExecutionError(
      output || value.message || "command failed",
      value.code,
    );
  }
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
  }
}

async function walkFiles(root: string, max = 5000): Promise<string[]> {
  const results: string[] = [];
  const queue = [""];
  while (queue.length > 0 && results.length < max) {
    const relativeDir = queue.shift() ?? "";
    const absoluteDir = path.join(root, relativeDir);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        if (entry.isDirectory()) {
          continue;
        }
      }
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        queue.push(relative);
      } else if (entry.isFile()) {
        results.push(relative);
        if (results.length >= max) {
          break;
        }
      }
    }
  }
  return results;
}

export function isPathInside(root: string, target: string): boolean {
  return relativeInside(root, target) !== target;
}
