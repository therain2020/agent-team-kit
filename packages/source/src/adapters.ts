import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type {
  EvidenceError,
  EvidenceSet,
  EvidenceSource,
  RawSourceItem,
  SourceDefinition,
} from "./types";

const USER_AGENT = "agent-team-kit/0.1";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export const BUILTIN_SOURCES = ["hn", "arxiv", "github"] as const;
export type BuiltinSource = (typeof BUILTIN_SOURCES)[number];

export function isBuiltinSource(value: string): value is BuiltinSource {
  return (BUILTIN_SOURCES as readonly string[]).includes(value);
}

async function fetchText(
  url: string,
  timeoutMs = 20000,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function fetchJson<T>(
  url: string,
  timeoutMs = 15000,
  headers: Record<string, string> = {},
): Promise<T> {
  return JSON.parse(await fetchText(url, timeoutMs, headers)) as T;
}

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  time?: number;
  score?: number;
  text?: string;
}

export async function fetchHn(limit: number): Promise<RawSourceItem[]> {
  const ids = await fetchJson<number[]>(
    "https://hacker-news.firebaseio.com/v0/topstories.json",
  );

  const items = await Promise.all(
    ids.slice(0, limit).map(async (id) => {
      try {
        return await fetchJson<HnItem | null>(
          `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
        );
      } catch {
        return null;
      }
    }),
  );

  return items
    .filter((item): item is HnItem =>
      Boolean(item && item.type === "story" && item.title),
    )
    .map((item) => ({
      source: "hn" as const,
      sourceId: `hn:${item.id}`,
      title: item.title ?? "",
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
      publishedAt: item.time
        ? new Date(item.time * 1000).toISOString()
        : undefined,
      summary: item.text ? stripHtml(item.text).slice(0, 300) : undefined,
      score: item.score,
    }));
}

export async function fetchArxiv(limit: number): Promise<RawSourceItem[]> {
  const url = `http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;
  const xml = await fetchText(url, 30000);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(
    (match) => match[1] ?? "",
  );

  return entries.flatMap((entry) => {
    const rawId = decodeXml(matchTag(entry, "id")).trim();
    const title = collapse(decodeXml(matchTag(entry, "title")));
    if (!rawId || !title) {
      return [];
    }

    const id = rawId.replace("http://", "https://");
    const publishedAt = decodeXml(matchTag(entry, "published")).trim();
    const summary = collapse(decodeXml(matchTag(entry, "summary"))).slice(
      0,
      300,
    );

    return [
      {
        source: "arxiv" as const,
        sourceId: `arxiv:${id.split("/abs/").pop() ?? id}`,
        title,
        url: id,
        publishedAt: publishedAt || undefined,
        summary: summary || undefined,
      },
    ];
  });
}

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
}

export async function fetchGithub(limit: number): Promise<RawSourceItem[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const query = encodeURIComponent(`created:>${since} stars:>50`);
  const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${limit}`;
  const payload = await fetchJson<{ items?: GhRepo[] }>(url, 20000, {
    accept: "application/vnd.github+json",
  });

  return (payload.items ?? []).map((repo) => ({
    source: "github" as const,
    sourceId: `gh:${repo.full_name}`,
    title: repo.full_name,
    url: repo.html_url,
    publishedAt: repo.created_at,
    summary: repo.description ?? undefined,
    score: repo.stargazers_count,
  }));
}

export async function fetchBuiltin(
  source: BuiltinSource,
  limit: number,
): Promise<RawSourceItem[]> {
  if (source === "hn") {
    return fetchHn(limit);
  }
  if (source === "arxiv") {
    return fetchArxiv(limit);
  }
  return fetchGithub(limit);
}

export async function validateSourceEndpoint(url: string): Promise<void> {
  await assertPublicUrl(url);
}

export async function fetchFromDefinition(
  definition: SourceDefinition,
  limit: number,
): Promise<RawSourceItem[]> {
  const maxItems = Math.min(
    Math.max(1, limit),
    definition.spec.limits?.maxItems ?? 100,
  );
  const timeoutMs = Math.min(definition.spec.limits?.timeoutMs ?? 20000, 30000);
  const text = await safeFetchText(
    definition.spec.request.url,
    timeoutMs,
    definition.spec.request.headers ?? {},
  );

  if (definition.spec.type === "rss") {
    return parseRss(text, definition, maxItems);
  }
  return parseJsonSource(text, definition, maxItems);
}

function parseRss(
  xml: string,
  definition: SourceDefinition,
  limit: number,
): RawSourceItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((match) => match[0]);

  return blocks.slice(0, limit).flatMap((block) => {
    const title = collapse(
      decodeXml(matchTag(block, "title") ?? matchTag(block, "media:title")),
    );
    const rawLink = matchTag(block, "link");
    const link =
      decodeXml(rawLink).trim() ||
      decodeXml(block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? "");
    const url = link || decodeXml(matchTag(block, "guid")).trim();
    if (!title || !url) {
      return [];
    }
    const publishedAt = decodeXml(
      matchTag(block, "pubDate") ??
        matchTag(block, "published") ??
        matchTag(block, "updated"),
    ).trim();
    const summary = collapse(
      decodeXml(matchTag(block, "description") ?? matchTag(block, "summary")),
    ).slice(0, 300);

    return [
      {
        source: definition.metadata.name,
        sourceId: `${definition.metadata.name}:${shortHash(url)}`,
        title,
        url,
        publishedAt: publishedAt || undefined,
        summary: summary || undefined,
      },
    ];
  });
}

function parseJsonSource(
  text: string,
  definition: SourceDefinition,
  limit: number,
): RawSourceItem[] {
  const data = JSON.parse(text) as unknown;
  const mapping = definition.spec.mapping ?? {};
  const items = resolvePath(data, mapping.items ?? "$");
  if (!Array.isArray(items)) {
    throw new Error("source mapping did not resolve to an array");
  }

  return items.slice(0, limit).flatMap((item) => {
    if (typeof item === "string") {
      return [
        {
          source: definition.metadata.name,
          sourceId: `${definition.metadata.name}:${shortHash(item)}`,
          title: item,
          url: item,
        },
      ];
    }
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const title = asString(
      resolvePath(record, mapping.title ?? "title") ??
        resolvePath(record, "name"),
    );
    const url = asString(
      resolvePath(record, mapping.url ?? "url") ??
        resolvePath(record, "link") ??
        resolvePath(record, "html_url"),
    );
    if (!title || !url) {
      return [];
    }
    const publishedAt = asString(
      resolvePath(record, mapping.publishedAt ?? "publishedAt") ??
        resolvePath(record, "created_at") ??
        resolvePath(record, "pubDate"),
    );
    const summary = collapse(
      asString(
        resolvePath(record, mapping.summary ?? "summary") ??
          resolvePath(record, "description"),
      ),
    ).slice(0, 300);
    const score = asNumber(
      resolvePath(record, mapping.score ?? "score") ??
        resolvePath(record, "stargazers_count"),
    );

    return [
      {
        source: definition.metadata.name,
        sourceId: `${definition.metadata.name}:${shortHash(url)}`,
        title,
        url,
        publishedAt: publishedAt || undefined,
        summary: summary || undefined,
        score,
      },
    ];
  });
}

export function buildEvidenceSet(
  items: RawSourceItem[],
  errors: EvidenceError[] = [],
  generatedAt = new Date().toISOString(),
): EvidenceSet {
  const seen = new Set<string>();
  const sources: EvidenceSource[] = [];

  for (const item of items) {
    if (seen.has(item.url)) {
      continue;
    }
    seen.add(item.url);
    sources.push({
      ...item,
      citationId: `S${sources.length + 1}`,
    });
  }

  return { generatedAt, sources, errors };
}

async function safeFetchText(
  input: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> {
  let url = input;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`redirect without location (${response.status})`);
      }
      url = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      throw new Error("source response exceeds 5MB");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      throw new Error("source response exceeds 5MB");
    }
    return text;
  }
  throw new Error("too many redirects");
}

async function assertPublicUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("source URL must use http or https");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0"
  ) {
    throw new Error("source URL points to a private host");
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`cannot resolve source host: ${hostname}`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateIp(entry.address))
  ) {
    throw new Error("source URL resolves to a private address");
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

function resolvePath(value: unknown, path: string): unknown {
  if (!path || path === "$") {
    return value;
  }
  const parts = path.replace(/^\$\./, "").split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function matchTag(entry: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = entry.match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`),
  );
  return match?.[1] ?? "";
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
