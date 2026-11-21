import {
  DEFAULT_INTEREST_PROFILE,
  type InterestProfile,
  type SignalBlock,
  type SignalFlag,
  type SignalThresholds,
} from "@kit/core";

/**
 * Interest-based signal scoring (98 §3.2, issue #128).
 *
 * The scorer is deliberately deterministic and model-free: relevance comes from
 * topic/entity matches against the {@link InterestProfile}, novelty from the
 * seen set plus similarity against a recent-event window, urgency from
 * freshness and source kind, risk from sensitivity/conflict/injection, and
 * confidence from provenance and claim confidence. It is labelled
 * `model: heuristic` — no model key is required and no network call is made.
 *
 * The 10/50 handling path is expressed as flags, never as silent drops:
 * conflicting claims and suspected prompt injection are kept in the event as
 * data-only content, marked `conflict` / `injection-suspected`, and surfaced in
 * `risk` and `reasons` so the source plane (10) and security plane (50) can act.
 */

export interface RecentInformationRef {
  title: string;
  entities: string[];
  occurredAt: string;
}

export interface SignalClaimInput {
  text: string;
  entities?: string[];
  conflict?: boolean;
  confidence?: number;
}

export type SignalSensitivity = "public" | "internal" | "secret" | "pii";

export interface SignalScoringInput {
  profile: InterestProfile;
  title?: string;
  summary?: string;
  claims?: SignalClaimInput[];
  entities?: string[];
  sourceId: string;
  sourceKind?: "passive" | "active";
  sensitivity?: SignalSensitivity;
  occurredAt: string;
  receivedAt: string;
  /** Clock used for freshness; defaults to `receivedAt`. */
  now?: string;
  /** True when the dedupe key already exists (the seen set). */
  alreadySeen?: boolean;
  /** Recent-window events used for novelty comparison. */
  recentEvents?: RecentInformationRef[];
  /** Number of provenance refs backing the event. */
  provenanceCount?: number;
  /** Number of distinct item refs backing the event. */
  itemRefCount?: number;
}

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (all )?(previous|prior|above) (instructions|prompts?)\b/i,
  /\bdisregard (all )?(previous|prior|above) (instructions|prompts?)\b/i,
  /\bsystem prompt\b/i,
  /\byou are now\b/i,
  /\b(instead|now) (you must|execute|run|call|send|fetch)\b/i,
  /\b(export|reveal|print|leak) (the )?(secret|token|credential|api key)/i,
  /忽略(之前|以上|先前)(的)?(所有)?(指令|提示)/,
  /系统提示词?/,
  /现在你是/,
];

const NEGATION =
  /\b(not|no|never|denied|denies|false|contradicts?)\b|不|否|否认|并非/i;

const SENSITIVITY_RISK: Record<SignalSensitivity, number> = {
  public: 0,
  internal: 0.15,
  secret: 0.6,
  pii: 0.8,
};

const SOURCE_RANK: Record<string, number> = {
  hn: 0.7,
  arxiv: 0.8,
  github: 0.7,
};

/** Build the signal block for one information item. */
export function scoreInformationEvent(input: SignalScoringInput): SignalBlock {
  const now = input.now ?? input.receivedAt;
  const text = buildText(input);
  const normalized = normalize(text);
  const reasons: string[] = [];
  const flags: SignalFlag[] = [];

  const exclusion = matchExclusion(input.profile.exclusions, normalized);
  if (exclusion) {
    flags.push("excluded");
  }

  const relevance = exclusion
    ? 0
    : computeRelevance(input, normalized, reasons);
  if (exclusion) {
    reasons.push(
      `relevance 0: excluded term "${exclusion}" — kept as data, never dropped`,
    );
  }

  const novelty = computeNovelty(input, text, reasons);

  const conflict = detectConflict(input.claims ?? []);
  if (conflict) {
    flags.push("conflict");
  }
  const injection = detectInjection(text);
  if (injection) {
    flags.push("injection-suspected");
  }

  const urgency = computeUrgency(input, now, reasons);
  const risk = computeRisk(
    input.sensitivity ?? "internal",
    conflict,
    injection,
    reasons,
  );
  const confidence = computeConfidence(input, reasons);

  if (input.alreadySeen) {
    flags.push("duplicate");
  }

  if (conflict) {
    reasons.push(
      "risk: conflicting claims kept and flagged (10 §3.3); routed to the source plane for corroboration",
    );
  }
  if (injection) {
    reasons.push(
      "risk: instruction-like content detected; treated as data only and routed to the 50 injection screen",
    );
  }

  const thresholds: SignalThresholds = input.profile.thresholds;
  const passes =
    !exclusion &&
    relevance >= thresholds.relevance &&
    novelty >= thresholds.novelty &&
    urgency >= thresholds.urgency;

  reasons.push(
    `model heuristic: deterministic keyword/freshness scoring, profile v${input.profile.version}`,
  );

  return {
    relevance: round(relevance),
    novelty: round(novelty),
    urgency: round(urgency),
    risk: round(risk),
    confidence: round(confidence),
    reasons,
    model: "heuristic",
    profileVersion: input.profile.version,
    thresholds,
    passes,
    flags,
    scoredAt: new Date(now).toISOString(),
  };
}

function buildText(input: SignalScoringInput): string {
  const parts = [input.title ?? "", input.summary ?? ""];
  for (const claim of input.claims ?? []) {
    parts.push(claim.text);
    for (const entity of claim.entities ?? []) {
      parts.push(entity);
    }
  }
  for (const entity of input.entities ?? []) {
    parts.push(entity);
  }
  return parts.filter(Boolean).join(" ");
}

function computeRelevance(
  input: SignalScoringInput,
  normalized: string,
  reasons: string[],
): number {
  const profile = input.profile;
  const topics = profile.topics.filter(Boolean);
  const entities = unique([
    ...profile.entities,
    ...(input.entities ?? []),
    ...(input.claims ?? []).flatMap((claim) => claim.entities ?? []),
  ]);

  const topicMatches = matchTerms(topics, normalized);
  const entityMatches = matchTerms(entities, normalized);
  const topicScore =
    topics.length > 0 ? topicMatches.length / topics.length : 0.3;
  const entityScore =
    entities.length > 0 ? entityMatches.length / entities.length : 0.3;
  const score = clamp01(0.65 * topicScore + 0.35 * entityScore);

  reasons.push(
    `relevance ${round(score)}: topics ${
      topics.length > 0
        ? `${topicMatches.length}/${topics.length}${
            topicMatches.length > 0 ? ` (${topicMatches.join(", ")})` : ""
          }`
        : "none configured (neutral 0.3)"
    }; entities ${
      entities.length > 0
        ? `${entityMatches.length}/${entities.length}${
            entityMatches.length > 0 ? ` (${entityMatches.join(", ")})` : ""
          }`
        : "none configured (neutral 0.3)"
    }`,
  );
  return score;
}

function computeNovelty(
  input: SignalScoringInput,
  text: string,
  reasons: string[],
): number {
  if (input.alreadySeen) {
    reasons.push("novelty 0: already in the seen set (duplicate dedupe key)");
    return 0;
  }
  const current = tokens(text);
  const recent = input.recentEvents ?? [];
  if (recent.length === 0 || current.size === 0) {
    reasons.push(
      `novelty 1.00: no recent window to compare (${recent.length} prior events)`,
    );
    return 1;
  }
  let best = 0;
  for (const ref of recent) {
    const similarity = jaccard(
      current,
      tokens(`${ref.title} ${ref.entities.join(" ")}`),
    );
    best = Math.max(best, similarity);
  }
  const novelty = clamp01(1 - best);
  reasons.push(
    `novelty ${round(novelty)}: max ${round(best)} overlap with ${recent.length} recent event(s)`,
  );
  return novelty;
}

function computeUrgency(
  input: SignalScoringInput,
  now: string,
  reasons: string[],
): number {
  const hours = hoursBetween(input.occurredAt, now);
  const freshness = Number.isFinite(hours)
    ? hours <= 6
      ? 1
      : hours >= 72
        ? 0
        : 1 - (hours - 6) / 66
    : 0;
  const sourceRank =
    input.sourceKind === "active" ? 0.85 : (SOURCE_RANK[input.sourceId] ?? 0.6);
  const score = clamp01(0.75 * freshness + 0.25 * sourceRank);
  reasons.push(
    `urgency ${round(score)}: published ${
      Number.isFinite(hours) ? `${round(hours)}h ago` : "at an unknown time"
    }; source ${input.sourceKind ?? "passive"} ${input.sourceId}`,
  );
  return score;
}

function computeRisk(
  sensitivity: SignalSensitivity,
  conflict: boolean,
  injection: boolean,
  reasons: string[],
): number {
  let score = SENSITIVITY_RISK[sensitivity] ?? 0.15;
  if (conflict) {
    score += 0.3;
  }
  if (injection) {
    score += 0.5;
  }
  score = clamp01(score);
  reasons.push(
    `risk ${round(score)}: sensitivity ${sensitivity}; conflict ${
      conflict ? "yes" : "no"
    }; injection suspect ${injection ? "yes" : "no"}`,
  );
  return score;
}

function computeConfidence(
  input: SignalScoringInput,
  reasons: string[],
): number {
  const provenance = Math.max(1, input.provenanceCount ?? 1);
  const itemRefs = Math.max(1, input.itemRefCount ?? 1);
  const claims = input.claims ?? [];
  const avgClaimConfidence =
    claims.length > 0
      ? claims.reduce((sum, claim) => sum + (claim.confidence ?? 0.5), 0) /
        claims.length
      : 0.5;
  const entityBonus = (input.entities?.length ?? 0) > 0 ? 0.05 : 0;
  const score = clamp01(
    0.35 +
      0.1 * Math.min(provenance, 3) +
      0.1 * Math.min(itemRefs, 3) +
      0.3 * avgClaimConfidence +
      entityBonus,
  );
  reasons.push(
    `confidence ${round(score)}: ${provenance} provenance ref(s), ${itemRefs} item ref(s), avg claim confidence ${round(avgClaimConfidence)}`,
  );
  return score;
}

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectConflict(claims: SignalClaimInput[]): boolean {
  if (claims.some((claim) => claim.conflict)) {
    return true;
  }
  const negated = claims.filter((claim) => NEGATION.test(claim.text));
  return (
    claims.length > 1 && negated.length > 0 && negated.length < claims.length
  );
}

/** Deterministically true when all thresholded dimensions clear the profile. */
export function passesThresholds(
  signals: Pick<SignalBlock, "relevance" | "novelty" | "urgency" | "flags">,
  thresholds: SignalThresholds,
): boolean {
  if (signals.flags.includes("excluded")) {
    return false;
  }
  return (
    signals.relevance >= thresholds.relevance &&
    signals.novelty >= thresholds.novelty &&
    signals.urgency >= thresholds.urgency
  );
}

export interface InterestProfileDraft {
  topics: string[];
  entities: string[];
  exclusions: string[];
  thresholds: SignalThresholds;
  dailyBudgetCny: number;
  rationale: string;
  model: "heuristic";
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "from",
  "about",
  "into",
  "that",
  "this",
  "these",
  "those",
  "want",
  "need",
  "please",
  "on",
  "in",
  "of",
  "to",
  "is",
  "are",
  "be",
  "by",
  "as",
  "at",
  "it",
  "we",
  "us",
  "our",
  "my",
  "me",
  "关注",
  "需要",
  "有关",
  "以及",
  "并且",
]);

const EXCLUSION_MARKERS = [
  "exclude",
  "excluding",
  "except",
  "without",
  "not interested",
  "不要",
  "排除",
  "不包括",
  "不关注",
];

/**
 * Deterministic intent → profile draft (D-64). The object plus one sentence is
 * returned to the editor; nothing is persisted until a human approves. When a
 * model key is unavailable this is the labeled `model: heuristic` path.
 */
export function draftInterestProfile(
  intent: string,
  base?: Pick<
    InterestProfile,
    "topics" | "entities" | "exclusions" | "thresholds" | "dailyBudgetCny"
  > | null,
): InterestProfileDraft {
  const trimmed = intent.trim();
  const exclusions: string[] = [];
  const inclusionClauses: string[] = [];

  for (const clause of trimmed.split(/[;；\n]|[,，、]/)) {
    const lower = clause.toLowerCase();
    const marker = EXCLUSION_MARKERS.map((value) => ({
      value,
      index: lower.indexOf(value),
    }))
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    if (marker) {
      const before = clause.slice(0, marker.index).trim();
      if (before) {
        inclusionClauses.push(before);
      }
      const rest = clause.slice(marker.index + marker.value.length);
      exclusions.push(...extractTerms(rest));
    } else if (clause.trim()) {
      inclusionClauses.push(clause);
    }
  }

  const extractedTopics = unique(
    extractTerms(inclusionClauses.join(" ")),
  ).slice(0, 8);
  const extractedEntities = unique(extractEntities(trimmed)).slice(0, 8);

  const mergedBase = base
    ? {
        topics: unique([...base.topics, ...extractedTopics]),
        entities: unique([...base.entities, ...extractedEntities]),
        exclusions: unique([...base.exclusions, ...exclusions]),
        thresholds: base.thresholds,
        dailyBudgetCny: base.dailyBudgetCny,
      }
    : {
        topics: extractedTopics,
        entities: extractedEntities,
        exclusions: unique(exclusions),
        thresholds: DEFAULT_INTEREST_PROFILE.thresholds,
        dailyBudgetCny: DEFAULT_INTEREST_PROFILE.dailyBudgetCny,
      };

  const summary = trimmed
    ? `Heuristic draft for "${truncate(trimmed, 80)}": ${mergedBase.topics.length} topic(s), ${mergedBase.entities.length} entity(ies), ${mergedBase.exclusions.length} exclusion(s).`
    : "Heuristic draft from the existing profile: no new intent supplied.";

  return {
    topics: mergedBase.topics,
    entities: mergedBase.entities,
    exclusions: mergedBase.exclusions,
    thresholds: mergedBase.thresholds,
    dailyBudgetCny: mergedBase.dailyBudgetCny,
    rationale: summary,
    model: "heuristic",
  };
}

function extractTerms(text: string): string[] {
  const matches =
    text.match(/[A-Za-z0-9][A-Za-z0-9.+#-]{1,}|[㐀-鿿]{2,}/g) ?? [];
  return matches
    .map((term) => term.toLowerCase())
    .filter((term) => !STOPWORDS.has(term) && !/^\d+$/.test(term));
}

function extractEntities(text: string): string[] {
  const matches =
    text.match(
      /"[^"]+"|“[^”]+”|\b[A-Z][A-Za-z0-9.+-]{1,}(?:[ -][A-Z][A-Za-z0-9.+-]{1,})*/g,
    ) ?? [];
  return matches
    .map((term) => term.replace(/["“”]/g, "").trim())
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term.toLowerCase()));
}

function matchExclusion(
  exclusions: string[],
  normalizedText: string,
): string | null {
  for (const exclusion of exclusions) {
    const term = exclusion.trim().toLowerCase();
    if (term && normalizedText.includes(term)) {
      return exclusion;
    }
  }
  return null;
}

function matchTerms(terms: string[], normalizedText: string): string[] {
  return terms.filter((term) =>
    normalizedText.includes(term.trim().toLowerCase()),
  );
}

function tokens(text: string): Set<string> {
  const normalized = normalize(text);
  const set = new Set<string>();
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  for (const token of latin) {
    set.add(token);
  }
  const cjk = normalized.match(/[㐀-鿿]{2,}/g) ?? [];
  for (const run of cjk) {
    // Bigrams keep Chinese similarity meaningful without a segmenter.
    for (let index = 0; index < run.length - 1; index += 1) {
      set.add(run.slice(index, index + 2));
    }
    if (run.length >= 2) {
      set.add(run);
    }
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function hoursBetween(iso: string, now: string): number {
  const start = Date.parse(iso);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.NaN;
  }
  return Math.max(0, (end - start) / 3_600_000);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
