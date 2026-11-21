import { createHash } from "node:crypto";
import path from "node:path";
import { type InformationSensitivity, newId } from "@kit/core";
import { type OpLogStore, appendOp } from "@kit/store";
import {
  type ToolContext,
  type ToolResult,
  type ToolRisk,
  executeTool,
  getTool,
} from "@kit/tools";
import {
  type InformationCollectorStore,
  type SourceCollectionSummary,
  ingestInformationItems,
} from "./collect";
import { detectInjection, draftInterestProfile } from "./scoring";
import type { RawSourceItem } from "./types";

/**
 * Active research scout (98 §3.1 / §6 I-4).
 *
 * The loop is deterministic: derive search keywords from the one-line interest,
 * search public developer sources, read matching repository docs, optionally
 * fetch the top result pages, and ingest everything through
 * {@link ingestInformationItems}. That shared path is what makes scout output
 * isomorphic to passive subscription output, so ReactionRule consumers cannot
 * tell the two apart except by `sourceKind`.
 *
 * Security boundaries (50 §3.1/§3.3):
 * - only the read-only tools below are callable; writes and command execution
 *   are refused before reaching the tool registry;
 * - network access is off unless the caller (config/env) explicitly enables it;
 * - fetched text is data. The loop only extracts a title/first paragraph for an
 *   item summary; it never interprets or follows instructions found there.
 *   Injection-like text is flagged in the audit and by the signal scorer.
 */

export const SCOUT_SOURCE_ID = "scout";

export const SCOUT_ALLOWED_TOOLS = [
  "web_search",
  "http_fetch",
  "repo_list",
  "repo_read",
  "repo_search",
] as const;

export type ScoutToolName = (typeof SCOUT_ALLOWED_TOOLS)[number];

const TOOL_RISK: Record<ScoutToolName, ToolRisk> = {
  web_search: "network",
  http_fetch: "network",
  repo_list: "read",
  repo_read: "read",
  repo_search: "read",
};

export class ScoutPermissionError extends Error {
  readonly code = "scout_permission_denied";

  constructor(message: string) {
    super(message);
    this.name = "ScoutPermissionError";
  }
}

export interface ScoutToolCallAudit {
  callId: string;
  runId: string;
  workspaceId: string;
  tool: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
  ok: boolean;
  startedAt: string;
  durationMs: number;
  resultChars: number;
  /** Set when the tool output looks instruction-like (50 §3.2). Data only. */
  injectionSuspected: boolean;
  error?: string;
}

export interface ScoutAuditSink {
  record(call: ScoutToolCallAudit): Promise<void>;
}

/** Durable audit artifact: one op-log row per tool call. */
export function opLogScoutAudit(store: OpLogStore): ScoutAuditSink {
  return {
    async record(call) {
      await appendOp(store, {
        workspaceId: call.workspaceId,
        entityKind: "scout",
        entityId: call.runId,
        op: "scout.tool_call",
        actor: "scout",
        origin: "agent",
        payload: call,
      });
    },
  };
}

export type ScoutToolRunner = (
  name: ScoutToolName,
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export function isScoutTool(name: string): name is ScoutToolName {
  return (SCOUT_ALLOWED_TOOLS as readonly string[]).includes(name);
}

/**
 * Execute one scout tool after the read-only/network gate. Anything outside the
 * allowlist is refused, so a stale plan cannot reach a write tool.
 */
export async function executeScoutTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!isScoutTool(name)) {
    throw new ScoutPermissionError(
      `tool "${name}" is not permitted for scout; research is read-only`,
    );
  }
  const tool = getTool(name);
  if (!tool) {
    throw new ScoutPermissionError(`unknown scout tool: ${name}`);
  }
  if (tool.definition.risk === "write" || tool.definition.risk === "execute") {
    throw new ScoutPermissionError(
      `tool "${name}" would write or execute; scout refuses writes`,
    );
  }
  if (tool.definition.risk === "network" && !context.allowNetwork) {
    throw new ScoutPermissionError(
      "external network access is disabled for scout (set KIT_SCOUT_ALLOW_NETWORK=1)",
    );
  }
  return executeTool(name, args, context);
}

export interface ScoutStore extends InformationCollectorStore {
  sql?: OpLogStore["sql"];
}

export interface RunScoutOptions {
  workspaceId?: string;
  /** One-line interest; also the primary search query. */
  interest: string;
  /**
   * Explicit network authorization. Defaults to
   * `KIT_SCOUT_ALLOW_NETWORK === "1"`; never taken from request input.
   */
  allowNetwork?: boolean;
  repoRoot?: string;
  maxQueries?: number;
  maxItems?: number;
  maxPageFetches?: number;
  maxRepoDocs?: number;
  sensitivity?: InformationSensitivity;
  costCnyMicro?: number;
  clock?: () => Date;
  /** Deterministic seam for tests. */
  toolRunner?: ScoutToolRunner;
  audit?: ScoutAuditSink;
}

export interface ScoutRunResult {
  runId: string;
  workspaceId: string;
  interest: string;
  startedAt: string;
  finishedAt: string;
  allowNetwork: boolean;
  queries: string[];
  items: RawSourceItem[];
  toolCalls: ScoutToolCallAudit[];
  ingested: SourceCollectionSummary;
  warnings: string[];
}

interface ScoutHit {
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  score?: number;
}

const silentAudit: ScoutAuditSink = {
  async record() {},
};

/** Research one interest and ingest the results into the information plane. */
export async function runScout(
  store: ScoutStore,
  options: RunScoutOptions,
): Promise<ScoutRunResult> {
  const interest = options.interest.trim();
  if (!interest) {
    throw new Error("scout requires a one-line interest");
  }
  const workspaceId = options.workspaceId ?? "default";
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const allowNetwork =
    options.allowNetwork ?? process.env.KIT_SCOUT_ALLOW_NETWORK === "1";
  const repoRoot = options.repoRoot ?? process.cwd();
  const maxQueries = clamp(options.maxQueries ?? 2, 1, 5);
  const maxItems = clamp(options.maxItems ?? 10, 1, 30);
  const maxPageFetches = clamp(options.maxPageFetches ?? 3, 0, 10);
  const maxRepoDocs = clamp(options.maxRepoDocs ?? 2, 0, 10);
  const runId = newId("scout");
  const calls: ScoutToolCallAudit[] = [];
  const warnings: string[] = [];
  const audit =
    options.audit ??
    (store.sql ? opLogScoutAudit({ sql: store.sql }) : silentAudit);

  const context: ToolContext = {
    repoRoot,
    sandboxRoot: path.join(repoRoot, ".tmp", "scout", runId),
    runId,
    workspaceId,
    runMode: allowNetwork ? "LIVE" : "DRY_RUN",
    allowNetwork,
    allowLocalhost: false,
  };
  const runner: ScoutToolRunner =
    options.toolRunner ??
    ((name, args) => executeScoutTool(name, args, context));

  const call = async (tool: ScoutToolName, args: Record<string, unknown>) => {
    const callStartedAt = clock().toISOString();
    const startedMs = Date.now();
    try {
      const result = await runner(tool, args, context);
      await record({
        callId: newId("scall"),
        runId,
        workspaceId,
        tool,
        args,
        risk: TOOL_RISK[tool],
        ok: true,
        startedAt: callStartedAt,
        durationMs: Date.now() - startedMs,
        resultChars: result.content.length,
        injectionSuspected: detectInjection(result.content),
      });
      return result;
    } catch (error) {
      await record({
        callId: newId("scall"),
        runId,
        workspaceId,
        tool,
        args,
        risk: TOOL_RISK[tool],
        ok: false,
        startedAt: callStartedAt,
        durationMs: Date.now() - startedMs,
        resultChars: 0,
        injectionSuspected: false,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  async function record(entry: ScoutToolCallAudit): Promise<void> {
    calls.push(entry);
    await audit.record(entry);
  }

  async function attempt<T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      // Permission denials are configuration errors, not flaky sources.
      if (error instanceof ScoutPermissionError) {
        throw error;
      }
      warnings.push(`${label}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  const webQueries = buildWebQueries(interest, maxQueries);
  const repoQueries = buildKeywordQueries(interest, maxQueries);
  const collected: RawSourceItem[] = [];

  for (const query of repoQueries) {
    if (maxRepoDocs === 0) {
      break;
    }
    await attempt(`repo_search "${query}"`, async () => {
      const result = await call("repo_search", {
        query,
        glob: "md",
        maxResults: 8,
      });
      for (const file of readRepoMatches(result.content, maxRepoDocs)) {
        const read = await call("repo_read", { path: file, endLine: 30 });
        collected.push(repoDocItem(file, query, stripRepoRead(read.content)));
      }
    });
  }

  if (allowNetwork) {
    for (const query of webQueries) {
      await attempt(`web_search "${query}"`, async () => {
        const result = await call("web_search", { query, maxResults: 5 });
        const hits = readSearchHits(result);
        if (hits.length === 0) {
          warnings.push(`web_search "${query}" returned no results`);
        }
        for (const hit of hits) {
          collected.push(hitToItem(hit));
        }
      });
    }

    const pages = dedupeItems(
      collected.filter((item) => item.url.startsWith("http")),
    ).slice(0, maxPageFetches);
    for (const item of pages) {
      await attempt(`http_fetch ${item.url}`, async () => {
        // Fetched text is data (50 §3.1). Only a readable summary is lifted;
        // anything instruction-like is never acted on.
        const result = await call("http_fetch", { url: item.url });
        const summary = extractPageSummary(result.content);
        if (summary && !item.summary) {
          item.summary = summary;
        }
      });
    }
  } else {
    warnings.push(
      "network disabled: scouted repository docs only (set KIT_SCOUT_ALLOW_NETWORK=1 to search public pages)",
    );
  }

  const items = dedupeItems(collected).slice(0, maxItems);
  const finishedAt = clock().toISOString();
  const ingested = await ingestInformationItems(store, {
    workspaceId,
    sourceId: SCOUT_SOURCE_ID,
    sourceKind: "active",
    fetchedAt: finishedAt,
    latencyMs: elapsedMs(startedAt, finishedAt),
    now: startedAt,
    items,
    sensitivity: options.sensitivity ?? "internal",
    costCnyMicro: options.costCnyMicro ?? 0,
  });

  return {
    runId,
    workspaceId,
    interest,
    startedAt,
    finishedAt,
    allowNetwork,
    queries: webQueries,
    items,
    toolCalls: calls,
    ingested,
    warnings,
  };
}

/** Search-engine style queries: the sentence plus derived keywords. */
export function buildWebQueries(interest: string, max: number): string[] {
  const normalized = collapse(interest).slice(0, 160);
  const keywords = keywordQuery(interest);
  return unique(
    [normalized, keywords].filter((query) => query.length >= 3),
  ).slice(0, Math.max(1, max));
}

/** Literal repository search works on single keywords, not whole sentences. */
export function buildKeywordQueries(interest: string, max: number): string[] {
  const limit = Math.max(1, max);
  const draft = draftInterestProfile(interest);
  const keywords = unique([...draft.topics, ...draft.entities])
    .filter((term) => term.length >= 3)
    .slice(0, limit);
  if (keywords.length > 0) {
    return keywords;
  }
  const normalized = collapse(interest).slice(0, 160);
  return normalized.length >= 3 ? [normalized] : [];
}

function keywordQuery(interest: string): string {
  const draft = draftInterestProfile(interest);
  return unique([...draft.topics, ...draft.entities])
    .slice(0, 3)
    .join(" ");
}

function repoDocItem(
  file: string,
  query: string,
  excerpt: string,
): RawSourceItem {
  return {
    source: SCOUT_SOURCE_ID,
    sourceId: `${SCOUT_SOURCE_ID}:repo:${shortHash(file)}`,
    title: `${file} · ${query}`.slice(0, 200),
    url: `repo://${file}`,
    summary:
      excerpt || `Repository documentation matched "${query}" in ${file}.`,
  };
}

function hitToItem(hit: ScoutHit): RawSourceItem {
  return {
    source: SCOUT_SOURCE_ID,
    sourceId: `${SCOUT_SOURCE_ID}:${shortHash(hit.url)}`,
    title: hit.title.slice(0, 200),
    url: hit.url,
    ...(normalizeDate(hit.publishedAt)
      ? { publishedAt: normalizeDate(hit.publishedAt) }
      : {}),
    ...(hit.summary ? { summary: hit.summary.slice(0, 300) } : {}),
    ...(typeof hit.score === "number" ? { score: hit.score } : {}),
  };
}

function readSearchHits(result: ToolResult): ScoutHit[] {
  const raw = result.metadata?.results;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : "";
    const url = typeof record.url === "string" ? record.url : "";
    if (!title || !url) {
      return [];
    }
    return [
      {
        title,
        url,
        ...(typeof record.publishedAt === "string"
          ? { publishedAt: record.publishedAt }
          : {}),
        ...(typeof record.summary === "string"
          ? { summary: record.summary }
          : {}),
        ...(typeof record.score === "number" ? { score: record.score } : {}),
      },
    ];
  });
}

/** `repo_search` output is `path:line: text`; keep distinct file paths. */
function readRepoMatches(content: string, limit: number): string[] {
  const files: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(.+?):\d+:/);
    const file = match?.[1]?.trim() ?? "";
    if (!file || files.includes(file)) {
      continue;
    }
    files.push(file);
    if (files.length >= limit) {
      break;
    }
  }
  return files;
}

function stripRepoRead(content: string): string {
  return collapse(
    content
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.replace(/^\d+:\s?/, ""))
      .join(" "),
  ).slice(0, 300);
}

/** Extract only a readable summary; the page body is never executed. */
function extractPageSummary(content: string): string | undefined {
  const separator = content.indexOf("\n\n");
  const body = separator >= 0 ? content.slice(separator + 2) : content;
  const paragraphs = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) ?? [];
  const text = stripTags(paragraphs.join(" ")) || stripTags(body);
  return text ? collapse(text).slice(0, 300) : undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function dedupeItems(items: RawSourceItem[]): RawSourceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function elapsedMs(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
