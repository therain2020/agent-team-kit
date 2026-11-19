import { createModelGateway, loadModelConfig } from "@kit/model";
import { JobError } from "./types";

/**
 * Source intent composer (issue #123, plan 94 §4 C-7, D-64).
 *
 * The caller (web layer) searches the unified source market and hands the
 * candidates in as plain facts. Nothing here invents a repo: the model may
 * only pick a repo that already exists in the candidate list, and every risk
 * field is derived deterministically from the manifest — never from the model.
 */

export interface SourceManifestFacts {
  name: string;
  version: string;
  type: "rss" | "json" | "github";
  endpoint: string;
  license?: string;
  homepage?: string;
  /** Header names declared by the manifest; values never leave the web layer. */
  headerNames: string[];
  /** Header names whose value looks like a credential (detected, not echoed). */
  credentialHeaders: string[];
  tos?: string;
  attribution?: "required" | "optional" | "none";
  complianceNotes?: string;
}

export interface SourceCandidateInput {
  repo: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  topics: string[];
  updatedAt: string;
  manifest?: SourceManifestFacts;
  manifestError?: string;
}

export interface SourceRiskSummary {
  level: "low" | "medium" | "high";
  network: string;
  endpoint: string;
  trust: string;
  auth: string;
  rateLimits: string;
  tos: string;
  credibility: string;
  secret: string;
  notes: string[];
}

export interface SourceCandidateSummary extends SourceCandidateInput {
  risk: SourceRiskSummary;
}

export interface SourceDraftValues {
  /** Selected repo, or "" when the market returned no installable candidate. */
  repo: string;
  reason: string;
  risk: SourceRiskSummary | null;
  /** Every candidate the draft was chosen from, with deterministic risk. */
  candidates: SourceCandidateSummary[];
}

const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const NON_SECRET_HEADERS = new Set(["accept", "user-agent", "content-type"]);
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "source",
  "sources",
  "feed",
  "news",
  "data",
  "我需要",
  "帮我",
  "一个",
  "信源",
]);

/**
 * Credential-like header names for a manifest, by name or by a long,
 * token-shaped value. Only the names are returned so secrets never reach the
 * model or the draft payload.
 */
export function credentialHeaderNames(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) {
    return [];
  }
  return Object.entries(headers)
    .filter(([name, value]) => {
      if (CREDENTIAL_HEADER.test(name)) {
        return true;
      }
      if (NON_SECRET_HEADERS.has(name.toLowerCase())) {
        return false;
      }
      const trimmed = value.trim();
      return trimmed.length >= 16 && /^[\w.~+/=-]+$/.test(trimmed);
    })
    .map(([name]) => name);
}

function endpointHost(endpoint: string): { host: string; https: boolean } {
  try {
    const url = new URL(endpoint);
    return { host: url.host, https: url.protocol === "https:" };
  } catch {
    return { host: endpoint, https: false };
  }
}

function updatedLabel(updatedAt: string): string {
  const parsed = new Date(updatedAt);
  return Number.isNaN(parsed.getTime())
    ? "unknown"
    : parsed.toISOString().slice(0, 10);
}

/** Deterministic risk summary for one market candidate. */
export function summarizeSourceRisk(
  candidate: SourceCandidateInput,
): SourceRiskSummary {
  const notes: string[] = [];
  const manifest = candidate.manifest;
  const secret = manifest
    ? manifest.credentialHeaders.length > 0
      ? `发现凭据头：${manifest.credentialHeaders.join(", ")}；安装前需确认来源可信`
      : "未发现凭据头"
    : "无 manifest，无法判断";
  if (manifest && !secret.startsWith("未发现")) {
    notes.push(
      `凭据头 ${manifest.credentialHeaders.join(", ")} 不会被发送给模型。`,
    );
  }

  if (!manifest) {
    return {
      level: "high",
      network: "无 manifest，无法确定网络请求",
      endpoint: "",
      trust: "third-party",
      auth: "未知",
      rateLimits: "未知",
      tos: "未提供 ToS/署名信息",
      credibility: `${candidate.stars} stars · 更新于 ${updatedLabel(candidate.updatedAt)} · ${candidate.manifestError ?? "manifest 无效"}`,
      secret,
      notes,
    };
  }

  const { host, https } = endpointHost(manifest.endpoint);
  if (!https) {
    notes.push("端点不是 HTTPS，数据传输可能被窃听。");
  }
  const auth =
    manifest.credentialHeaders.length > 0
      ? `声明凭据头：${manifest.credentialHeaders.join(", ")}（值保留在本地）`
      : manifest.headerNames.length > 0
        ? `声明自定义头：${manifest.headerNames.join(", ")}`
        : "未声明认证";
  const tos = manifest.tos
    ? `已提供 ToS：${manifest.tos}`
    : manifest.attribution === "required"
      ? "未提供 ToS；要求署名"
      : "未提供 ToS/署名信息";
  if (!manifest.tos) {
    notes.push("manifest 未提供使用条款链接，请自行确认上游条款。");
  }
  if (manifest.attribution === "required") {
    notes.push("上游要求署名，展示时必须保留出处。");
  }

  const updated = new Date(candidate.updatedAt).getTime();
  const stale = Number.isFinite(updated)
    ? Date.now() - updated > 365 * 24 * 60 * 60 * 1000
    : true;
  if (stale) {
    notes.push("仓库超过一年未更新。");
  }
  if (candidate.stars < 10) {
    notes.push("仓库关注度较低。");
  }

  const level: SourceRiskSummary["level"] =
    manifest.credentialHeaders.length > 0 || !https
      ? "high"
      : !manifest.tos ||
          manifest.attribution === "required" ||
          candidate.stars < 10 ||
          stale
        ? "medium"
        : "low";

  return {
    level,
    network: `出站 HTTP（${manifest.type}）→ ${host}`,
    endpoint: manifest.endpoint,
    trust: "third-party",
    auth,
    rateLimits: "manifest 未声明速率限制，需遵守上游策略",
    tos,
    credibility: `${candidate.stars} stars · 更新于 ${updatedLabel(candidate.updatedAt)} · manifest 有效`,
    secret,
    notes,
  };
}

export function summarizeSourceCandidates(
  candidates: SourceCandidateInput[],
): SourceCandidateSummary[] {
  return candidates.map((candidate) => ({
    ...candidate,
    risk: summarizeSourceRisk(candidate),
  }));
}

/** Only candidates with a valid manifest may be installed or selected. */
export function selectableCandidates(
  candidates: SourceCandidateSummary[],
): SourceCandidateSummary[] {
  return candidates.filter((candidate) => candidate.manifest !== undefined);
}

function candidateHaystack(candidate: SourceCandidateSummary): string {
  return [
    candidate.repo,
    candidate.description ?? "",
    candidate.topics.join(" "),
    candidate.manifest?.name ?? "",
    candidate.manifest?.type ?? "",
    candidate.manifest?.endpoint ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Deterministic keyword pick over the actual candidates. Returns null when the
 * market is empty — the caller must surface an empty state instead of a draft.
 */
export function heuristicSourcePick(
  intent: string,
  candidates: SourceCandidateSummary[],
): { candidate: SourceCandidateSummary | null; reason: string } {
  const eligible = selectableCandidates(candidates);
  if (eligible.length === 0) {
    return { candidate: null, reason: "" };
  }

  const text = intent.trim().toLowerCase();
  const words = [
    ...new Set(
      text
        .split(/[^a-z0-9一-鿿]+/)
        .filter((word) => word.length >= 2 && !STOP_WORDS.has(word)),
    ),
  ];

  let best: {
    candidate: SourceCandidateSummary;
    score: number;
    hit: string;
  } | null = null;
  for (const candidate of eligible) {
    const haystack = candidateHaystack(candidate);
    let score = 0;
    let hit = "";
    let hitWeight = 0;
    if (text.length >= 2 && haystack.includes(text)) {
      score += 4;
      hit = intent.trim();
      hitWeight = 4;
    }
    for (const word of words) {
      if (!haystack.includes(word)) {
        continue;
      }
      const weight = candidate.repo.toLowerCase().includes(word) ? 3 : 1;
      score += weight;
      if (weight > hitWeight) {
        hit = word;
        hitWeight = weight;
      }
    }
    if (
      !best ||
      score > best.score ||
      (score === best.score && candidate.stars > best.candidate.stars)
    ) {
      best = { candidate, score, hit };
    }
  }

  if (!best) {
    return { candidate: null, reason: "" };
  }
  return {
    candidate: best.candidate,
    reason:
      best.score > 0
        ? `关键词匹配「${best.hit}」`
        : `没有直接关键词命中，按热度选择（${best.candidate.stars} stars）`,
  };
}

/**
 * Validate a model-proposed repo against the real candidate list. Unknown or
 * uninstallable repos are rejected so the model cannot fabricate a source.
 */
export function selectSourceCandidate(
  parsed: Record<string, unknown>,
  candidates: SourceCandidateSummary[],
): { repo: string | null; reason?: string; warnings: string[] } {
  const warnings: string[] = [];
  const eligible = new Set(
    selectableCandidates(candidates).map((candidate) => candidate.repo),
  );
  const repo =
    typeof parsed.repo === "string" && eligible.has(parsed.repo.trim())
      ? parsed.repo.trim()
      : null;
  if (typeof parsed.repo === "string" && !repo) {
    warnings.push("AI 选择的信源不在候选列表中，已回退启发式选择。");
  }
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 300)
      : undefined;
  if (Array.isArray(parsed.warnings)) {
    warnings.push(
      ...parsed.warnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 5),
    );
  }
  return { repo, ...(reason ? { reason } : {}), warnings };
}

export interface SourceComposeResult {
  kind: "source";
  values: SourceDraftValues;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

export async function composeSource(
  intent: string,
  candidates: SourceCandidateInput[],
  env: Record<string, string | undefined>,
): Promise<SourceComposeResult> {
  const trimmed = intent.trim();
  if (!trimmed) {
    throw new JobError("intent_required", "a one-line intent is required", 400);
  }
  const summaries = summarizeSourceCandidates(candidates);
  const eligible = selectableCandidates(summaries);
  if (eligible.length === 0) {
    return {
      kind: "source",
      values: { repo: "", reason: "", risk: null, candidates: summaries },
      rationale: "信源市场没有找到可安装的候选，请换个说法或手动搜索。",
      warnings: [
        candidates.length === 0
          ? "搜索结果为空；未生成任何候选。"
          : "候选都缺少有效的 source.yaml，不能安装。",
      ],
      model: "heuristic",
    };
  }

  const heuristic = heuristicSourcePick(trimmed, summaries);
  let selected = heuristic.candidate;
  let reason = heuristic.reason;
  let rationale =
    "只从市场实际返回的候选中选择；风险摘要来自 manifest，不经过模型。";
  const warnings: string[] = [];
  let model: SourceComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You pick ONE source adapter for a private agent team.
Return JSON only:
{"repo":"<owner/name>","reason":"<one sentence>","rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- repo MUST be one of the provided candidate repos that has a valid manifest.
- never invent repos, endpoints, permissions or risk details.
- prefer the candidate that best matches the intent; explain why in reason.
- risk is computed elsewhere; do not claim a candidate is safe.`,
      input: JSON.stringify({
        intent: trimmed,
        candidates: eligible.map((candidate) => ({
          repo: candidate.repo,
          description: candidate.description,
          stars: candidate.stars,
          topics: candidate.topics,
          name: candidate.manifest?.name,
          type: candidate.manifest?.type,
          endpoint: candidate.manifest?.endpoint,
        })),
      }),
    });
    const parsed = parseJsonObject(response.text);
    if (parsed) {
      const validated = selectSourceCandidate(parsed, summaries);
      warnings.push(...validated.warnings);
      if (validated.repo) {
        const chosen = eligible.find(
          (candidate) => candidate.repo === validated.repo,
        );
        if (chosen) {
          selected = chosen;
          reason = validated.reason ?? reason;
          rationale =
            typeof parsed.rationale === "string" && parsed.rationale.trim()
              ? parsed.rationale.trim().slice(0, 500)
              : rationale;
          model = "live";
        }
      }
    } else {
      warnings.push("AI 草稿无法解析，已使用启发式候选。");
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用启发式候选。");
  }

  return {
    kind: "source",
    values: {
      repo: selected?.repo ?? "",
      reason,
      risk: selected?.risk ?? null,
      candidates: summaries,
    },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
