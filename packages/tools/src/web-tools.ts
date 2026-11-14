import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { argString, resolveInside, truncate } from "./paths";
import type { Tool, ToolContext } from "./types";

const execFileAsync = promisify(execFile);

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
