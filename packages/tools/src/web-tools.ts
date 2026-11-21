import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { argNumber, argString, resolveInside, truncate } from "./paths";
import type { Tool, ToolContext } from "./types";

const execFileAsync = promisify(execFile);

/** One result from {@link webSearchTool}; data only, never instructions. */
export interface WebSearchHit {
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  score?: number;
  provider: "hackernews" | "github";
}

interface HnSearchHit {
  objectID?: string;
  title?: string;
  url?: string;
  created_at?: string;
  points?: number;
  story_text?: string;
}

interface GhSearchRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  created_at?: string;
}

export const webSearchTool: Tool = {
  definition: {
    name: "web_search",
    description:
      "Search public developer sources (Hacker News stories and GitHub repositories) for a keyword query. Returns titles, links and dates as data.",
    risk: "network",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords" },
        maxResults: {
          type: "number",
          description: "Results per provider (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
  async execute(args, context) {
    const query = argString(args, "query");
    const max = Math.max(1, Math.min(argNumber(args, "maxResults") ?? 5, 10));
    const errors: string[] = [];
    const hits: WebSearchHit[] = [];

    const hnUrl = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${max}&query=${encodeURIComponent(query)}`;
    try {
      const payload = await searchJson<{ hits?: HnSearchHit[] }>(
        hnUrl,
        context,
      );
      for (const hit of payload.hits ?? []) {
        const id = hit.objectID ?? "";
        const url = hit.url || `https://news.ycombinator.com/item?id=${id}`;
        if (!hit.title || !url) {
          continue;
        }
        hits.push({
          title: hit.title,
          url,
          ...(hit.created_at ? { publishedAt: hit.created_at } : {}),
          ...(hit.story_text
            ? { summary: stripHtml(hit.story_text).slice(0, 300) }
            : {}),
          ...(typeof hit.points === "number" ? { score: hit.points } : {}),
          provider: "hackernews",
        });
      }
    } catch (error) {
      errors.push(`hackernews: ${errorMessage(error)}`);
    }

    const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${max}`;
    try {
      const payload = await searchJson<{ items?: GhSearchRepo[] }>(
        ghUrl,
        context,
        {
          accept: "application/vnd.github+json",
          ...(process.env.GITHUB_TOKEN
            ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
      );
      for (const repo of payload.items ?? []) {
        if (!repo.full_name || !repo.html_url) {
          continue;
        }
        hits.push({
          title: repo.full_name,
          url: repo.html_url,
          ...(repo.created_at ? { publishedAt: repo.created_at } : {}),
          ...(repo.description
            ? { summary: repo.description.slice(0, 300) }
            : {}),
          ...(typeof repo.stargazers_count === "number"
            ? { score: repo.stargazers_count }
            : {}),
          provider: "github",
        });
      }
    } catch (error) {
      errors.push(`github: ${errorMessage(error)}`);
    }

    if (hits.length === 0 && errors.length > 0) {
      throw new Error(`web search failed (${errors.join("; ")})`);
    }

    return {
      content: truncate(
        hits
          .map(
            (hit) =>
              `${hit.title} — ${hit.url}${hit.publishedAt ? ` (${hit.publishedAt.slice(0, 10)})` : ""}`,
          )
          .join("\n") || "(no results)",
        20_000,
      ),
      metadata: { results: hits, errors, query },
    };
  },
};

async function searchJson<T>(
  url: string,
  context: Pick<ToolContext, "allowNetwork" | "allowLocalhost">,
  headers: Record<string, string> = {},
): Promise<T> {
  await assertUrlAllowed(url, context);
  const response = await fetch(url, {
    headers: { "user-agent": "agent-team-kit/1.0", ...headers },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const httpFetchTool: Tool = {
  definition: {
    name: "http_fetch",
    description:
      "Fetch an HTTP(S) URL as text. Private hosts are blocked; localhost is allowed only when the Kit enables local inspection. Use for checking local pages or public docs.",
    risk: "network",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) URL" },
      },
      required: ["url"],
    },
  },
  async execute(args, context) {
    const url = argString(args, "url");
    await assertUrlAllowed(url, context);
    const response = await fetch(url, {
      headers: { "user-agent": "agent-team-kit/1.0" },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return {
        content: `HTTP ${response.status} redirect to ${response.headers.get("location") ?? "(missing)"}`,
      };
    }
    const text = (await response.text()).slice(0, 40_000);
    return {
      content: truncate(
        `HTTP ${response.status} ${response.statusText}\ncontent-type: ${response.headers.get("content-type") ?? "unknown"}\n\n${text}`,
        40_000,
      ),
      metadata: { status: response.status },
    };
  },
};

export const browserInspectTool: Tool = {
  definition: {
    name: "browser_inspect",
    description:
      "Open a URL with the configured headless browser adapter and return page text. Requires KIT_BROWSE_BIN or a `browse` executable. Optionally writes a screenshot into the run sandbox.",
    risk: "network",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) URL to inspect" },
        screenshot: {
          type: "boolean",
          description: "Write a screenshot into the run sandbox",
        },
      },
      required: ["url"],
    },
  },
  async execute(args, context) {
    const url = argString(args, "url");
    await assertUrlAllowed(url, context);
    const binary = process.env.KIT_BROWSE_BIN ?? "browse";
    if (binary.includes(path.sep) || binary.includes("/")) {
      await fs.access(binary);
    }
    try {
      await execFileAsync(binary, ["goto", url], {
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      const textResult = await execFileAsync(binary, ["text"], {
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      let screenshotPath: string | undefined;
      if (args.screenshot === true) {
        screenshotPath = resolveInside(
          context.sandboxRoot,
          `browser-${Date.now()}.png`,
        );
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await execFileAsync(binary, ["screenshot", screenshotPath], {
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
      }
      return {
        content: truncate(
          `${textResult.stdout}${textResult.stderr}${screenshotPath ? `\n\nscreenshot: ${screenshotPath}` : ""}`,
          40_000,
        ),
        metadata: { screenshotPath },
      };
    } catch (error) {
      const value = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      throw new Error(
        value.stderr ||
          value.stdout ||
          value.message ||
          `browser adapter failed: ${binary}`,
      );
    }
  },
};

export async function assertUrlAllowed(
  input: string,
  context: Pick<ToolContext, "allowNetwork" | "allowLocalhost">,
): Promise<void> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  const hostname = url.hostname.toLowerCase();
  const local =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (local) {
    if (!context.allowLocalhost) {
      throw new Error("localhost access is disabled");
    }
    return;
  }
  if (!context.allowNetwork) {
    throw new Error(
      "external network access is disabled in this run mode (use LIVE or KIT_TOOLS_ALLOW_NETWORK=1)",
    );
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`cannot resolve host: ${hostname}`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateIp(entry.address))
  ) {
    throw new Error("URL resolves to a private address");
  }
}

function isPrivateIp(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return true;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
