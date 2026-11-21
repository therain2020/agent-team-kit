import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type TrustedKey,
  formatSecretFindings,
  loadTrustedKeys,
  scanSecrets,
  sha256Hex,
  verifySignature,
  writeJsonAtomic,
} from "@kit/market";
import { parse } from "yaml";
import { validateSourceEndpoint } from "./adapters";
import { getSourcesRoot, loadInstalledSource } from "./registry";
import {
  type InstalledSource,
  type SourceBudget,
  type SourceDefinition,
  type SourceMeta,
  type SourceTrust,
  sourceDefinitionSchema,
} from "./types";

/**
 * Source self-manufacture (issue #131, plan 98 §3.4 / §6 I-5, 88 M1, 10 §3.6).
 *
 * Flow: intent → `source.yaml` draft → declarative schema + code-adapter
 * rejection + endpoint check + secret scan + trust grading → observer approval
 * → install into `sources/`. The AI only proposes: `createSourceProposal` never
 * writes into the library, and `installSourceProposal` refuses without an
 * explicit approval flag.
 *
 * Retirement is a proposal too: low-yield health generates one and applying it
 * only annotates `<name>.meta.json`; the manifest, raw captures and audit stay
 * on disk and `fetchSource` refuses a retired source instead of deleting it.
 */

const BUILTIN_NAMES = new Set(["hn", "arxiv", "github"]);
const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROPOSAL_ID_PATTERN = /^[0-9a-z-]+$/i;
const MANUFACTURE_DIR = ".manufacture";
const PROPOSALS_DIR = path.join(MANUFACTURE_DIR, "proposals");
const AUDIT_FILE = path.join(MANUFACTURE_DIR, "audit.jsonl");
const DECLARATIVE_TYPES = new Set(["rss", "json", "github"]);
const CODE_ADAPTER_TYPES = new Set([
  "code",
  "command",
  "script",
  "adapter",
  "python",
  "node",
  "shell",
]);
const CODE_KEYS = ["code", "command", "script"];

export type SourceProposalStatus =
  | "proposed"
  | "validated"
  | "approved"
  | "applied"
  | "rejected";

export type SourceProposalRiskLevel = "low" | "medium" | "high";

export interface SourceProposalIssue {
  code: string;
  path: string;
  message: string;
}

export interface SourceProposalRisk {
  level: SourceProposalRiskLevel;
  /** Installation always requires an explicit observer approval (I-5). */
  requiresApproval: boolean;
  reasons: string[];
}

export interface SourceGateResult {
  definition: SourceDefinition | null;
  issues: SourceProposalIssue[];
  trust: SourceTrust | null;
  secretScan: "passed" | "blocked";
  endpoint: "ok" | "unchecked" | "invalid";
}

export interface SourceProposal {
  id: string;
  target: "source";
  intent: string;
  name: string;
  status: SourceProposalStatus;
  yaml: string;
  issues: SourceProposalIssue[];
  risk: SourceProposalRisk;
  trust: SourceTrust | null;
  secretScan: "passed" | "blocked";
  model: "live" | "heuristic";
  rationale: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  approval: { at: string; actor: string } | null;
  applied: {
    at: string;
    actor: string;
    file: string;
    manifestSha256: string;
  } | null;
}

export interface SourceRetirementEvidence {
  runs: number;
  successes: number;
  failures: number;
  itemsCollected: number;
  eventsCreated: number;
  eventRatio: number;
  consecutiveFailures: number;
  degraded: boolean;
}

/** Plan 98 §2 `ManufactureProposal`, scoped to sources installed globally. */
export type SourceManufactureProposal = SourceProposal;

export interface SourceRetirementProposal {
  id: string;
  target: "source";
  kind: "retirement";
  sourceId: string;
  status: "proposed" | "applied" | "dismissed";
  reason: string;
  evidence: SourceRetirementEvidence;
  createdAt: string;
  appliedAt?: string;
  appliedBy?: string;
}

export interface SourceYieldHealth {
  sourceId: string;
  runs: number;
  successes: number;
  failures: number;
  itemsCollected: number;
  eventsCreated: number;
  consecutiveFailures: number;
  degraded: boolean;
}

export interface RetirementThresholds {
  /** Runs before yield is judged stable. */
  minRuns: number;
  /** Items collected before the ratio is meaningful. */
  minItems: number;
  /** Events per collected item below which the source is low-yield. */
  minEventRatio: number;
  /** Consecutive failures that also justify a retirement proposal. */
  minFailureStreak: number;
}

export const DEFAULT_RETIREMENT_THRESHOLDS: RetirementThresholds = {
  minRuns: 5,
  minItems: 10,
  minEventRatio: 0.2,
  minFailureStreak: 3,
};

export interface SourceYieldVerdict {
  lowYield: boolean;
  failing: boolean;
  eventRatio: number;
  reasons: string[];
}

export class SourceManufactureError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: SourceProposalIssue[];

  constructor(
    code: string,
    message: string,
    status = 400,
    issues: SourceProposalIssue[] = [],
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Gate: schema, code-adapter rejection, endpoint, secret, trust       */
/* ------------------------------------------------------------------ */

export interface SourceGateInput {
  yaml: string;
  keys?: TrustedKey[];
  /** Endpoint check seam; defaults to the SSRF-safe real validator. */
  validateEndpoint?: (url: string) => Promise<void>;
  /** Set false only for offline tests; the proposal is then not validated. */
  checkEndpoint?: boolean;
}

export async function gateSourceDraft(
  input: SourceGateInput,
): Promise<SourceGateResult> {
  const issues: SourceProposalIssue[] = [];
  let raw: unknown;
  try {
    raw = parse(input.yaml);
  } catch (error) {
    return {
      definition: null,
      issues: [
        {
          code: "invalid_yaml",
          path: "<root>",
          message: error instanceof Error ? error.message : "invalid YAML",
        },
      ],
      trust: null,
      secretScan: "passed",
      endpoint: "unchecked",
    };
  }

  const codeIssue = codeAdapterIssue(raw);
  if (codeIssue) {
    issues.push(codeIssue);
  }

  const parsed = sourceDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // The explicit code-adapter issue above already explains the rejection.
      if (
        codeIssue &&
        issue.path[0] === "spec" &&
        (issue.path[1] === "type" || issue.path[1] === "adapter")
      ) {
        continue;
      }
      issues.push({
        code: "schema_invalid",
        path: issue.path.join(".") || "<root>",
        message: issue.message,
      });
    }
  }
  const definition = parsed.success ? parsed.data : null;
  if (definition && BUILTIN_NAMES.has(definition.metadata.name)) {
    issues.push({
      code: "reserved_name",
      path: "metadata.name",
      message: `source name is reserved by a builtin: ${definition.metadata.name}`,
    });
  }

  const secretFindings = scanSecrets([
    { file: "source.yaml", content: input.yaml },
  ]);
  const secretScan = secretFindings.length > 0 ? "blocked" : "passed";
  if (secretFindings.length > 0) {
    issues.push({
      code: "secret_detected",
      path: "source.yaml",
      message: `source manifest contains secret-like content: ${formatSecretFindings(
        secretFindings,
      )}`,
    });
  }

  const keys = input.keys ?? (await loadKeysOrEmpty());
  const trust = definition ? verifySignature(definition, keys) : null;

  let endpoint: SourceGateResult["endpoint"] = "unchecked";
  if (input.checkEndpoint !== false && definition) {
    const validate = input.validateEndpoint ?? validateSourceEndpoint;
    try {
      await validate(definition.spec.request.url);
      endpoint = "ok";
    } catch (error) {
      endpoint = "invalid";
      issues.push({
        code: "endpoint_invalid",
        path: "spec.request.url",
        message:
          error instanceof Error ? error.message : "endpoint check failed",
      });
    }
  }

  return { definition, issues, trust, secretScan, endpoint };
}

function codeAdapterIssue(raw: unknown): SourceProposalIssue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const spec = (raw as Record<string, unknown>).spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return null;
  }
  const record = spec as Record<string, unknown>;
  const type = record.type;
  const request: Record<string, unknown> =
    record.request && typeof record.request === "object"
      ? (record.request as Record<string, unknown>)
      : {};
  const adapter = record.adapter;
  const codeType =
    typeof type === "string" &&
    !DECLARATIVE_TYPES.has(type) &&
    CODE_ADAPTER_TYPES.has(type);
  const codeAdapter =
    adapter === "code" || adapter === "command" || adapter === "script";
  const codeKey = CODE_KEYS.some((key) => record[key] !== undefined);
  const requestCode = CODE_KEYS.some((key) => request[key] !== undefined);
  if (!codeType && !codeAdapter && !codeKey && !requestCode) {
    return null;
  }
  return {
    code: "code_adapter_rejected",
    path: "spec",
    message:
      "code-type source adapters are not manufactured here; only declarative rss/json/github sources install through the market gate — route code through the code gate (plan 85)",
  };
}

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

export function assessSourceRisk(gate: SourceGateResult): SourceProposalRisk {
  const reasons: string[] = [];
  let level: SourceProposalRiskLevel = "low";
  const trust = gate.trust;
  if (!trust || (trust.level !== "verified" && trust.level !== "builtin")) {
    level = "medium";
    reasons.push("未签名或未验证的来源：安装必须由观察者显式批准");
  } else {
    reasons.push(`签名验证通过（${trust.level} / ${trust.signature}）`);
  }
  if (gate.secretScan === "blocked") {
    level = "high";
    reasons.push("manifest 命中 secret 扫描，安装被阻断");
  }
  if (gate.endpoint === "invalid") {
    level = "high";
    reasons.push("端点未通过公开地址校验，安装被阻断");
  }
  if (gate.definition) {
    const url = gate.definition.spec.request.url;
    if (url.startsWith("http://")) {
      level = "high";
      reasons.push("端点不是 HTTPS，数据传输可能被窃听");
    }
  }
  return { level, requiresApproval: true, reasons };
}

export interface CreateSourceProposalInput extends SourceGateInput {
  intent: string;
  yaml: string;
  root?: string;
  model?: "live" | "heuristic";
  rationale?: string;
  warnings?: string[];
  now?: string;
}

export async function createSourceProposal(
  input: CreateSourceProposalInput,
): Promise<SourceProposal> {
  const intent = input.intent.trim();
  if (!intent) {
    throw new SourceManufactureError(
      "intent_required",
      "a one-line intent is required",
    );
  }
  if (input.yaml.trim().length === 0) {
    throw new SourceManufactureError(
      "yaml_required",
      "source.yaml is required",
    );
  }
  const gate = await gateSourceDraft(input);
  const now = input.now ?? new Date().toISOString();
  const proposal: SourceProposal = {
    id: randomId(),
    target: "source",
    intent,
    name: gate.definition?.metadata.name ?? proposalName(input.yaml),
    status: statusForGate(gate, input.checkEndpoint),
    yaml: input.yaml,
    issues: gate.issues,
    risk: assessSourceRisk(gate),
    trust: gate.trust,
    secretScan: gate.secretScan,
    model: input.model ?? "heuristic",
    rationale:
      input.rationale ??
      "AI 只提案：端点、secret、签名与信任门禁通过后，仍需观察者显式批准才安装。",
    warnings: [...new Set(input.warnings ?? [])],
    createdAt: now,
    updatedAt: now,
    approval: null,
    applied: null,
  };
  await saveProposal(input.root, proposal);
  await appendAudit(input.root, {
    at: now,
    actor: "ai:source-composer",
    action: "proposed",
    target: "source",
    proposalId: proposal.id,
    name: proposal.name,
    status: proposal.status,
    risk: proposal.risk,
    trust: proposal.trust,
    issues: proposal.issues,
  });
  return proposal;
}

export interface ReviseSourceProposalInput extends SourceGateInput {
  id: string;
  yaml: string;
  root?: string;
  actor?: string;
  now?: string;
}

/** Observer edit before install; re-runs the full gate on the new YAML. */
export async function reviseSourceProposal(
  input: ReviseSourceProposalInput,
): Promise<SourceProposal> {
  const proposal = await requireProposal(input.id, input.root);
  if (proposal.status === "applied") {
    throw new SourceManufactureError(
      "already_applied",
      "this proposal is already installed; edit the installed source instead",
      409,
    );
  }
  const gate = await gateSourceDraft(input);
  proposal.yaml = input.yaml;
  proposal.name = gate.definition?.metadata.name ?? proposal.name;
  proposal.issues = gate.issues;
  proposal.risk = assessSourceRisk(gate);
  proposal.trust = gate.trust;
  proposal.secretScan = gate.secretScan;
  proposal.status = statusForGate(gate, input.checkEndpoint);
  proposal.updatedAt = input.now ?? new Date().toISOString();
  await saveProposal(input.root, proposal);
  await appendAudit(input.root, {
    at: proposal.updatedAt,
    actor: (input.actor ?? "observer").trim() || "observer",
    action: "revised",
    target: "source",
    proposalId: proposal.id,
    name: proposal.name,
    status: proposal.status,
    issues: proposal.issues,
  });
  return proposal;
}

export interface InstallSourceProposalInput extends SourceGateInput {
  id: string;
  /** Explicit observer approval; the only path that writes `sources/`. */
  approved: boolean;
  actor?: string;
  yaml?: string;
  root?: string;
  now?: string;
}

export interface InstalledSourceProposal {
  proposal: SourceProposal;
  installed: InstalledSource;
}

export async function installSourceProposal(
  input: InstallSourceProposalInput,
): Promise<InstalledSourceProposal> {
  let proposal = await requireProposal(input.id, input.root);
  if (proposal.status === "applied") {
    throw new SourceManufactureError(
      "already_applied",
      "this proposal is already installed",
      409,
    );
  }
  if (typeof input.yaml === "string" && input.yaml !== proposal.yaml) {
    const gate = await gateSourceDraft({ ...input, yaml: input.yaml });
    proposal = {
      ...proposal,
      yaml: input.yaml,
      name: gate.definition?.metadata.name ?? proposal.name,
      issues: gate.issues,
      risk: assessSourceRisk(gate),
      trust: gate.trust,
      secretScan: gate.secretScan,
      status: statusForGate(gate, input.checkEndpoint),
      updatedAt: input.now ?? new Date().toISOString(),
    };
    await saveProposal(input.root, proposal);
  }
  if (proposal.issues.length > 0) {
    throw new SourceManufactureError(
      "proposal_invalid",
      "the proposal has blocking issues; fix the draft first",
      409,
      proposal.issues,
    );
  }
  if (!input.approved) {
    throw new SourceManufactureError(
      "approval_required",
      "installation requires explicit observer approval",
      409,
    );
  }
  const gate = await gateSourceDraft({
    ...input,
    yaml: proposal.yaml,
    checkEndpoint: input.checkEndpoint ?? true,
  });
  const definition = gate.definition;
  if (!definition || gate.issues.length > 0) {
    throw new SourceManufactureError(
      "proposal_invalid",
      "the proposal no longer passes the gate",
      409,
      gate.issues,
    );
  }
  const name = definition.metadata.name;
  if (!SOURCE_NAME_PATTERN.test(name) || BUILTIN_NAMES.has(name)) {
    throw new SourceManufactureError(
      "reserved_name",
      `source name is reserved or invalid: ${name}`,
    );
  }

  const root = getSourcesRoot(input.root);
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.yaml`);
  const metaPath = path.join(root, `${name}.meta.json`);
  const previous = await snapshot(target, metaPath);
  const now = input.now ?? new Date().toISOString();
  const actor = (input.actor ?? "observer").trim() || "observer";
  const manifestSha256 = sha256Hex(proposal.yaml);
  const priorMeta = await readPriorMeta(metaPath);
  const meta: SourceMeta = {
    kind: "source",
    id: name,
    name,
    version: definition.metadata.version,
    entry: `${name}.yaml`,
    ...(definition.metadata.license
      ? { license: definition.metadata.license }
      : {}),
    repo: "local/manufacture",
    commit: manifestSha256.slice(0, 40),
    manifestSha256,
    installedAt: now,
    trust: gate.trust?.level ?? "community",
    ...(gate.trust ? { trustDetail: gate.trust } : {}),
    permissions: { network: true, filesystem: "readonly", code: false },
    files: { [`${name}.yaml`]: manifestSha256 },
    manifest: {
      id: name,
      name,
      version: definition.metadata.version,
      kind: "source",
      description: definition.metadata.description ?? "",
    },
    ...(definition.metadata.homepage
      ? { homepage: definition.metadata.homepage }
      : {}),
    secretScan: "passed",
    manufacture: {
      proposalId: proposal.id,
      actor,
      model: proposal.model,
    },
    ...(priorMeta?.budget ? { budget: priorMeta.budget } : {}),
  };

  try {
    await writeFileAtomic(target, proposal.yaml);
    await writeJsonAtomic(metaPath, meta);
  } catch (error) {
    await restore(previous);
    throw new SourceManufactureError(
      "install_failed",
      `source install failed and was rolled back: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }

  proposal.status = "applied";
  proposal.approval = { at: now, actor };
  proposal.applied = {
    at: now,
    actor,
    file: target,
    manifestSha256,
  };
  proposal.updatedAt = now;
  await saveProposal(input.root, proposal);
  await appendAudit(input.root, {
    at: now,
    actor,
    action: "installed",
    target: "source",
    proposalId: proposal.id,
    name,
    file: target,
    manifestSha256,
    trust: gate.trust,
  });

  return {
    proposal,
    installed: { definition, meta, file: target },
  };
}

export async function listSourceProposals(
  root?: string,
): Promise<SourceProposal[]> {
  const dir = proposalsDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const proposals: SourceProposal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        await readFile(path.join(dir, entry.name), "utf8"),
      ) as Partial<SourceProposal> & { kind?: string };
      if (
        parsed &&
        parsed.target === "source" &&
        parsed.kind !== "retirement" &&
        typeof parsed.id === "string" &&
        typeof parsed.yaml === "string"
      ) {
        proposals.push(parsed as SourceProposal);
      }
    } catch {
      // A corrupt proposal stays on disk but is skipped by the console.
    }
  }
  return proposals.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function loadSourceProposal(
  id: string,
  root?: string,
): Promise<SourceProposal | null> {
  if (!PROPOSAL_ID_PATTERN.test(id)) {
    return null;
  }
  const file = path.join(proposalsDir(root), `${id}.json`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      kind?: string;
    } & Partial<SourceProposal>;
    return parsed.kind === "retirement" || parsed.target !== "source"
      ? null
      : (parsed as SourceProposal);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Yield monitoring and retirement                                     */
/* ------------------------------------------------------------------ */

export function evaluateSourceYield(
  health: SourceYieldHealth,
  thresholds: RetirementThresholds = DEFAULT_RETIREMENT_THRESHOLDS,
): SourceYieldVerdict {
  const eventRatio =
    health.itemsCollected > 0
      ? health.eventsCreated / health.itemsCollected
      : 0;
  const lowYield =
    health.runs >= thresholds.minRuns &&
    health.itemsCollected >= thresholds.minItems &&
    eventRatio < thresholds.minEventRatio;
  const failing =
    health.consecutiveFailures >= thresholds.minFailureStreak ||
    (health.degraded && health.consecutiveFailures > 0);
  const reasons: string[] = [];
  if (lowYield) {
    reasons.push(
      `产出率 ${(eventRatio * 100).toFixed(0)}% 低于 ${(thresholds.minEventRatio * 100).toFixed(0)}%（${health.eventsCreated}/${health.itemsCollected} 条入库）`,
    );
  }
  if (failing) {
    reasons.push(
      `连续失败 ${health.consecutiveFailures} 次${health.degraded ? "，已降级" : ""}`,
    );
  }
  return { lowYield, failing, eventRatio, reasons };
}

export interface ListRetirementProposalsInput {
  health: SourceYieldHealth[];
  root?: string;
  thresholds?: RetirementThresholds;
  now?: string;
}

/**
 * Merge stored retirement proposals with ones derived from current health.
 * Generated ids are deterministic (`retire-<source>`) so approval is replayable;
 * a source already retired or a proposal already applied is not re-proposed.
 */
export async function listRetirementProposals(
  input: ListRetirementProposalsInput,
): Promise<SourceRetirementProposal[]> {
  const stored = await readStoredRetirements(input.root);
  const settled = new Set(
    stored
      .filter(
        (proposal) =>
          proposal.status === "applied" || proposal.status === "dismissed",
      )
      .map((proposal) => proposal.sourceId),
  );
  const now = input.now ?? new Date().toISOString();
  const generated: SourceRetirementProposal[] = [];
  for (const health of input.health) {
    const verdict = evaluateSourceYield(health, input.thresholds);
    if (!verdict.lowYield && !verdict.failing) {
      continue;
    }
    if (settled.has(health.sourceId)) {
      continue;
    }
    // Only installed sources can be retired; builtins have no record.
    const meta = await installedMeta(health.sourceId, input.root);
    if (!meta || meta.retiredAt) {
      continue;
    }
    if (stored.some((proposal) => proposal.sourceId === health.sourceId)) {
      continue;
    }
    generated.push({
      id: `retire-${health.sourceId}`,
      target: "source",
      kind: "retirement",
      sourceId: health.sourceId,
      status: "proposed",
      reason: verdict.reasons.join("；"),
      evidence: {
        runs: health.runs,
        successes: health.successes,
        failures: health.failures,
        itemsCollected: health.itemsCollected,
        eventsCreated: health.eventsCreated,
        eventRatio: verdict.eventRatio,
        consecutiveFailures: health.consecutiveFailures,
        degraded: health.degraded,
      },
      createdAt: now,
    });
  }
  return [
    ...stored.filter((proposal) => proposal.status === "proposed"),
    ...generated,
  ];
}

export async function loadRetirementProposal(
  id: string,
  root?: string,
): Promise<SourceRetirementProposal | null> {
  if (!PROPOSAL_ID_PATTERN.test(id)) {
    return null;
  }
  const file = path.join(proposalsDir(root), `${id}.json`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<SourceRetirementProposal>;
    return parsed.kind === "retirement" && typeof parsed.sourceId === "string"
      ? (parsed as SourceRetirementProposal)
      : null;
  } catch {
    return null;
  }
}

export interface RetireSourceInput {
  name: string;
  reason?: string;
  proposalId?: string;
  evidence?: Record<string, number | boolean>;
  actor?: string;
  root?: string;
  now?: string;
}

/**
 * Retire a source: annotate the meta record and stop collection. The manifest,
 * raw captures and audit are never deleted (10 §3.6, 98 §3.4).
 */
export async function retireSource(
  input: RetireSourceInput,
): Promise<InstalledSource> {
  const installed = await loadInstalledSource(input.name, input.root);
  if (!installed) {
    throw new SourceManufactureError(
      "not_found",
      `source not installed: ${input.name}`,
      404,
    );
  }
  if (installed.meta.retiredAt) {
    return installed;
  }
  const now = input.now ?? new Date().toISOString();
  const actor = (input.actor ?? "observer").trim() || "observer";
  const meta: SourceMeta = {
    ...installed.meta,
    retiredAt: now,
    retiredBy: actor,
    retirement: {
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      reason: input.reason?.trim() || "retired by observer",
      ...(input.evidence ? { evidence: input.evidence } : {}),
    },
  };
  const dir = getSourcesRoot(input.root);
  await writeJsonAtomic(path.join(dir, `${input.name}.meta.json`), meta);

  if (input.proposalId) {
    const stored = await loadRetirementProposal(input.proposalId, input.root);
    const generatedId = `retire-${input.name}`;
    const applied: SourceRetirementProposal | null =
      stored && stored.sourceId === input.name
        ? {
            ...stored,
            status: "applied",
            appliedAt: now,
            appliedBy: actor,
          }
        : stored === null && input.proposalId === generatedId
          ? {
              id: generatedId,
              target: "source",
              kind: "retirement",
              sourceId: input.name,
              status: "applied",
              reason: meta.retirement?.reason ?? "retired by observer",
              evidence: {
                runs: numericEvidence(input.evidence, "runs"),
                successes: numericEvidence(input.evidence, "successes"),
                failures: numericEvidence(input.evidence, "failures"),
                itemsCollected: numericEvidence(
                  input.evidence,
                  "itemsCollected",
                ),
                eventsCreated: numericEvidence(input.evidence, "eventsCreated"),
                eventRatio: numericEvidence(input.evidence, "eventRatio"),
                consecutiveFailures: numericEvidence(
                  input.evidence,
                  "consecutiveFailures",
                ),
                degraded: input.evidence?.degraded === true,
              },
              createdAt: now,
              appliedAt: now,
              appliedBy: actor,
            }
          : null;
    if (applied) {
      await writeJsonAtomic(
        path.join(proposalsDir(input.root), `${applied.id}.json`),
        applied,
      );
    }
  }

  await appendAudit(input.root, {
    at: now,
    actor,
    action: "retired",
    target: "source",
    name: input.name,
    proposalId: input.proposalId,
    reason: meta.retirement?.reason,
    evidence: meta.retirement?.evidence,
    kept: ["manifest", "meta", "raw captures", "audit"],
  });
  return { ...installed, meta };
}

/* ------------------------------------------------------------------ */
/* Observer edit and budget                                            */
/* ------------------------------------------------------------------ */

export interface UpdateSourceInput extends SourceGateInput {
  name: string;
  yaml: string;
  root?: string;
  actor?: string;
  now?: string;
}

/**
 * Observer edit: the edited YAML must pass the same gate, and the source name
 * cannot change (rename/retire are separate actions).
 */
export async function updateSourceDefinition(
  input: UpdateSourceInput,
): Promise<InstalledSource> {
  const installed = await loadInstalledSource(input.name, input.root);
  if (!installed) {
    throw new SourceManufactureError(
      "not_found",
      `source not installed: ${input.name}`,
      404,
    );
  }
  const gate = await gateSourceDraft(input);
  const definition = gate.definition;
  if (!definition || gate.issues.length > 0) {
    throw new SourceManufactureError(
      "proposal_invalid",
      "the edited source.yaml did not pass the gate",
      409,
      gate.issues,
    );
  }
  if (definition.metadata.name !== input.name) {
    throw new SourceManufactureError(
      "name_changed",
      "editing a source cannot rename it; install a new proposal instead",
      409,
    );
  }
  const now = input.now ?? new Date().toISOString();
  const actor = (input.actor ?? "observer").trim() || "observer";
  const manifestSha256 = sha256Hex(input.yaml);
  const meta: SourceMeta = {
    ...installed.meta,
    version: definition.metadata.version,
    manifestSha256,
    trust: gate.trust?.level ?? "community",
    ...(gate.trust ? { trustDetail: gate.trust } : {}),
    files: { [`${input.name}.yaml`]: manifestSha256 },
    secretScan: "passed",
    manifest: {
      id: input.name,
      name: input.name,
      version: definition.metadata.version,
      kind: "source",
      description: definition.metadata.description ?? "",
    },
  };
  const dir = getSourcesRoot(input.root);
  const target = path.join(dir, `${input.name}.yaml`);
  const metaPath = path.join(dir, `${input.name}.meta.json`);
  const previous = await snapshot(target, metaPath);
  try {
    await writeFileAtomic(target, input.yaml);
    await writeJsonAtomic(metaPath, meta);
  } catch (error) {
    await restore(previous);
    throw error;
  }
  await appendAudit(input.root, {
    at: now,
    actor,
    action: "edited",
    target: "source",
    name: input.name,
    manifestSha256,
    trust: gate.trust,
  });
  return { definition, meta, file: target };
}

export interface SetSourceBudgetInput {
  name: string;
  budget: SourceBudget;
  root?: string;
  actor?: string;
  now?: string;
}

export async function setSourceBudget(
  input: SetSourceBudgetInput,
): Promise<InstalledSource> {
  const installed = await loadInstalledSource(input.name, input.root);
  if (!installed) {
    throw new SourceManufactureError(
      "not_found",
      `source not installed: ${input.name}`,
      404,
    );
  }
  const { dailyCostCny, maxItemsPerRun } = input.budget;
  if (!Number.isFinite(dailyCostCny) || dailyCostCny < 0) {
    throw new SourceManufactureError(
      "invalid_budget",
      "dailyCostCny must be a non-negative number",
    );
  }
  if (
    !Number.isInteger(maxItemsPerRun) ||
    maxItemsPerRun < 1 ||
    maxItemsPerRun > 100
  ) {
    throw new SourceManufactureError(
      "invalid_budget",
      "maxItemsPerRun must be an integer between 1 and 100",
    );
  }
  const now = input.now ?? new Date().toISOString();
  const actor = (input.actor ?? "observer").trim() || "observer";
  const meta: SourceMeta = {
    ...installed.meta,
    budget: { dailyCostCny, maxItemsPerRun },
  };
  const dir = getSourcesRoot(input.root);
  await writeJsonAtomic(path.join(dir, `${input.name}.meta.json`), meta);
  await appendAudit(input.root, {
    at: now,
    actor,
    action: "budget-set",
    target: "source",
    name: input.name,
    budget: meta.budget,
  });
  return { ...installed, meta };
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

function statusForGate(
  gate: SourceGateResult,
  checkEndpoint: boolean | undefined,
): SourceProposalStatus {
  if (gate.issues.length > 0) {
    return "rejected";
  }
  return checkEndpoint === false ? "proposed" : "validated";
}

function proposalsDir(root?: string): string {
  return path.join(getSourcesRoot(root), PROPOSALS_DIR);
}

async function saveProposal(
  root: string | undefined,
  proposal: SourceProposal,
): Promise<void> {
  if (!PROPOSAL_ID_PATTERN.test(proposal.id)) {
    throw new SourceManufactureError(
      "invalid_proposal_id",
      "invalid proposal id",
    );
  }
  await writeJsonAtomic(
    path.join(proposalsDir(root), `${proposal.id}.json`),
    proposal,
  );
}

async function requireProposal(
  id: string,
  root?: string,
): Promise<SourceProposal> {
  const proposal = await loadSourceProposal(id, root);
  if (!proposal) {
    throw new SourceManufactureError(
      "not_found",
      `source proposal not found: ${id}`,
      404,
    );
  }
  return proposal;
}

async function readStoredRetirements(
  root?: string,
): Promise<SourceRetirementProposal[]> {
  const dir = proposalsDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const proposals: SourceRetirementProposal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        await readFile(path.join(dir, entry.name), "utf8"),
      ) as Partial<SourceRetirementProposal>;
      if (parsed.kind === "retirement" && typeof parsed.sourceId === "string") {
        proposals.push(parsed as SourceRetirementProposal);
      }
    } catch {
      // Ignore corrupt records; they stay on disk for manual recovery.
    }
  }
  return proposals.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

async function installedMeta(
  name: string,
  root?: string,
): Promise<SourceMeta | null> {
  try {
    return (await loadInstalledSource(name, root))?.meta ?? null;
  } catch {
    return null;
  }
}

async function appendAudit(
  root: string | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  const file = path.join(getSourcesRoot(root), AUDIT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

async function readPriorMeta(metaPath: string): Promise<SourceMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath, "utf8")) as SourceMeta;
  } catch {
    return null;
  }
}

interface FileSnapshot {
  file: string;
  existed: boolean;
  content: string;
}

async function snapshot(...files: string[]): Promise<FileSnapshot[]> {
  return Promise.all(
    files.map(async (file) => ({
      file,
      existed: existsSync(file),
      content: existsSync(file) ? await readFile(file, "utf8") : "",
    })),
  );
}

async function restore(snapshots: FileSnapshot[]): Promise<void> {
  for (const entry of snapshots) {
    if (entry.existed) {
      await writeFileAtomic(entry.file, entry.content).catch(() => undefined);
    } else {
      await rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function loadKeysOrEmpty(): Promise<TrustedKey[]> {
  try {
    return await loadTrustedKeys();
  } catch {
    return [];
  }
}

function numericEvidence(
  evidence: Record<string, number | boolean> | undefined,
  key: string,
): number {
  const value = evidence?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function proposalName(yaml: string): string {
  try {
    const raw = parse(yaml) as { metadata?: { name?: unknown } } | null;
    return typeof raw?.metadata?.name === "string"
      ? raw.metadata.name
      : "draft";
  } catch {
    return "draft";
  }
}

function randomId(): string {
  return `src-${randomUUID()}`;
}
