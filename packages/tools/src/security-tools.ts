import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { SKIP_DIRS, argString, resolveInside, truncate } from "./paths";
import type { Tool } from "./types";

interface Rule {
  id: string;
  severity: "high" | "medium" | "low";
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  {
    id: "secret-aws",
    severity: "high",
    pattern: /AKIA[0-9A-Z]{16}/,
    message: "possible AWS access key",
  },
  {
    id: "secret-generic",
    severity: "high",
    pattern:
      /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i,
    message: "possible hard-coded credential",
  },
  {
    id: "private-key",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    message: "private key material",
  },
  {
    id: "eval",
    severity: "high",
    pattern: /\beval\s*\(/,
    message: "dynamic eval",
  },
  {
    id: "new-function",
    severity: "medium",
    pattern: /new\s+Function\s*\(/,
    message: "dynamic Function constructor",
  },
  {
    id: "shell-exec",
    severity: "medium",
    pattern: /\b(?:exec|execSync|spawnSync)\s*\(/,
    message: "command execution primitive",
  },
  {
    id: "child-process",
    severity: "medium",
    pattern: /child_process/,
    message: "child_process usage",
  },
  {
    id: "inner-html",
    severity: "medium",
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=/,
    message: "raw HTML injection surface",
  },
  {
    id: "sql-concat",
    severity: "medium",
    pattern: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]{0,160}\+\s*[A-Za-z_$]/i,
    message: "possible SQL string concatenation",
  },
  {
    id: "tls-verify-off",
    severity: "high",
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
    message: "TLS verification disabled",
  },
  {
    id: "http-url",
    severity: "low",
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/,
    message: "plain HTTP endpoint",
  },
  {
    id: "path-traversal",
    severity: "medium",
    pattern: /\.\.[\\/]/,
    message: "possible path traversal construction",
  },
  {
    id: "permissive-cors",
    severity: "medium",
    pattern: /Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*/,
    message: "permissive CORS",
  },
];

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".sql",
]);

export const securityScanCodeTool: Tool = {
  definition: {
    name: "security_scan_code",
    description:
      "Static security scan of repository source files. Finds secrets, dynamic eval, shell execution, raw HTML, plain HTTP, TLS bypass and similar patterns. Findings are redacted and include path:line.",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative subtree (default '.')",
        },
        maxFindings: { type: "number", description: "Default 80, max 200" },
      },
    },
  },
  async execute(args, context) {
    const relative = argString(args, "path", false) || ".";
    const root = resolveInside(context.repoRoot, relative);
    const maxFindings = Math.min(
      typeof args.maxFindings === "number" ? args.maxFindings : 80,
      200,
    );
    const findings: Array<{
      rule: string;
      severity: string;
      message: string;
      path: string;
      line: number;
    }> = [];
    const files = await walk(root, 6000);
    for (const file of files) {
      if (!SCAN_EXTENSIONS.has(path.extname(file))) {
        continue;
      }
      if (file.endsWith(".env") || file.includes("/.env")) {
        continue;
      }
      let text: string;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 400_000) {
          continue;
        }
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const rule of RULES) {
          if (rule.pattern.test(line)) {
            findings.push({
              rule: rule.id,
              severity: rule.severity,
              message: rule.message,
              path: path
                .relative(context.repoRoot, file)
                .split(path.sep)
                .join("/"),
              line: index + 1,
            });
            if (findings.length >= maxFindings) {
              break;
            }
          }
        }
        if (findings.length >= maxFindings) {
          break;
        }
      }
      if (findings.length >= maxFindings) {
        break;
      }
    }
    return {
      content: truncate(
        JSON.stringify({ count: findings.length, findings }, null, 2),
        40_000,
      ),
      metadata: { count: findings.length },
    };
  },
};

export const securityScanDependenciesTool: Tool = {
  definition: {
    name: "security_scan_dependencies",
    description:
      "Static dependency and install-script scan. Flags wildcard/latest/git/http/file dependencies and risky install scripts. Does not query a CVE database.",
    risk: "read",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, context) {
    const findings: Array<{
      packageFile: string;
      packageName: string;
      version: string;
      reason: string;
    }> = [];
    const files = (await walk(context.repoRoot, 4000)).filter((file) =>
      file.endsWith("package.json"),
    );
    for (const file of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const packageFile = path
          .relative(context.repoRoot, file)
          .split(path.sep)
          .join("/");
        const deps = {
          ...(parsed.dependencies ?? {}),
          ...(parsed.devDependencies ?? {}),
        };
        for (const [name, version] of Object.entries(deps)) {
          if (
            version === "*" ||
            version === "latest" ||
            version.startsWith("git:") ||
            version.startsWith("http:") ||
            version.startsWith("https:") ||
            version.startsWith("file:")
          ) {
            findings.push({
              packageFile,
              packageName: name,
              version,
              reason:
                "unpinned or non-registry dependency; review supply-chain risk",
            });
          }
        }
        for (const [name, script] of Object.entries(parsed.scripts ?? {})) {
          if (
            /^(pre|post)?install$/.test(name) &&
            /(curl|wget|node\s+-e|bash|sh\s+-c|powershell)/i.test(script)
          ) {
            findings.push({
              packageFile,
              packageName: name,
              version: script.slice(0, 120),
              reason: "install script downloads or evaluates code",
            });
          }
        }
      } catch {
        // ignore malformed manifest
      }
    }
    return {
      content: truncate(
        JSON.stringify(
          {
            count: findings.length,
            packagesScanned: files.length,
            findings,
            note: "Static scan only. This is not a CVE database; pair it with npm/bun audit and review.",
          },
          null,
          2,
        ),
        30_000,
      ),
      metadata: { count: findings.length },
    };
  },
};

async function walk(root: string, max: number): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0 && results.length < max) {
    const dir = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        results.push(full);
        if (results.length >= max) {
          break;
        }
      }
    }
  }
  return results;
}
