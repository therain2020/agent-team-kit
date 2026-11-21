import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId } from "@kit/core";
import { createModelGateway } from "@kit/model";
import { loadPack } from "@kit/pack";
import { parse, stringify } from "yaml";
import {
  type EvolutionCallAttribution,
  attributedEvolutionGateway,
  evolutionCallScope,
} from "./cost-attribution";
import {
  EMPTY_HIDDEN_COVERAGE,
  type HiddenCase,
  type HiddenCoverage,
  appendHiddenAudit,
  auditRootForSnapshot,
  checkHiddenDraft,
  loadHiddenSuite,
} from "./hidden";
import type { EvolutionRepository } from "./repository";
import { readEvalSnapshotManifest, verifyEvalSnapshot } from "./snapshot";

export const DEFAULT_ARCHIVE = "variants/archive.jsonl";

export interface VariantMeta {
  id: string;
  name: string;
  parent: string | null;
  agentId: string;
  model: string;
  createdAt: string;
  baselineHashes: Record<string, string>;
  changedFiles: string[];
}

export interface EvolutionRecord {
  variantId: string;
  name: string;
  parent: string | null;
  agentId: string;
  stub: boolean;
  createdAt: string;
  pass: boolean;
  scores: Record<string, number>;
  rationale: string;
  costCny: number;
  tokens: number;
  draftChars: number;
}

export async function initVariant(
  packDir: string,
  outDir: string,
  name: string,
): Promise<{ meta: VariantMeta; dir: string }> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (existsSync(outDir)) {
    throw new Error(`variant output already exists: ${outDir}`);
  }

  await mkdir(path.dirname(path.resolve(outDir)), { recursive: true });
  await cp(loaded.dir, outDir, { recursive: true });

  const meta: VariantMeta = {
    id: newId("var"),
    name,
    parent: null,
    agentId: "",
    model: "",
    createdAt: new Date().toISOString(),
    baselineHashes: await hashLockedFiles(outDir),
    changedFiles: [],
  };

  await writeFile(
    path.join(outDir, "variant.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  return { meta, dir: path.resolve(outDir) };
}

export async function proposeVariant(
  fromDir: string,
  agentId: string,
  instructionsFile: string,
  outDir: string,
  name: string,
  model?: string,
): Promise<{ meta: VariantMeta; dir: string }> {
  const parentMeta = await readVariantMeta(fromDir);
  const loaded = await loadPack(fromDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }

  const agent = loaded.agents.get(agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  if (existsSync(outDir)) {
    throw new Error(`variant output already exists: ${outDir}`);
  }

  const body = (await readFile(instructionsFile, "utf8")).trim();
  const original = await readFile(
    path.join(loaded.dir, agent.spec.file),
    "utf8",
  );
  const frontmatterRaw = parseFrontmatter(original);
  const frontmatter =
    frontmatterRaw === undefined
      ? {}
      : (parse(frontmatterRaw) as Record<string, unknown>);
  const nextModel = model ?? agent.frontmatter.model;

  const updated = `---\n${stringify({ ...frontmatter, model: nextModel })}---\n\n${body}\n`;

  await mkdir(path.dirname(path.resolve(outDir)), { recursive: true });
  await cp(loaded.dir, outDir, { recursive: true });
  await writeFile(path.join(outDir, agent.spec.file), updated, "utf8");

  const meta: VariantMeta = {
    id: newId("var"),
    name,
    parent: parentMeta.id,
    agentId,
    model: nextModel,
    createdAt: new Date().toISOString(),
    baselineHashes: parentMeta.baselineHashes,
    changedFiles: [agent.spec.file],
  };

  await writeFile(
    path.join(outDir, "variant.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  return { meta, dir: path.resolve(outDir) };
}

export async function scoreVariant(
  variantDir: string,
  baselineDir: string,
  inputFile: string,
  agentId: string,
  options: {
    stub?: boolean;
    rubricRef?: string;
    archive?: string;
    repo?: EvolutionRepository;
    evalDir?: string;
    /** Charges draft/judge/hidden calls to the evolution cycle. */
    cost?: EvolutionCallAttribution;
  } = {},
): Promise<EvolutionRecord> {
  const meta = await readVariantMeta(variantDir);
  await verifyLockedFiles(variantDir, meta.baselineHashes);

  const variant = await loadPack(variantDir);
  if (!variant.ok) {
    throw new Error(variant.errors.join("\n"));
  }
  const baseline = await loadPack(baselineDir);
  if (!baseline.ok) {
    throw new Error(baseline.errors.join("\n"));
  }

  const agent = variant.agents.get(agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${agentId}`);
  }

  const evidence = await readFile(inputFile, "utf8");
  const [rubricFile, rubricKey] = (
    options.rubricRef ?? "evals/visible/rubrics.yaml#radar"
  ).split("#");

  let rubricRoot = baseline.dir;
  let evalDir: string | undefined;
  if (options.evalDir) {
    const verification = await verifyEvalSnapshot(options.evalDir);
    if (!verification.ok) {
      throw new Error(
        `frozen eval snapshot failed verification: ${verification.mismatches.join(", ")}`,
      );
    }
    evalDir = path.resolve(options.evalDir);
    rubricRoot = evalDir;
  }

  const rubricDoc = parse(
    await readFile(resolveRubricPath(rubricRoot, rubricFile ?? ""), "utf8"),
  ) as {
    rubrics?: Record<
      string,
      { dimensions: Record<string, { weight: number; threshold: number }> }
    >;
  };
  const rubric = rubricKey ? rubricDoc.rubrics?.[rubricKey] : undefined;
  if (!rubric) {
    throw new Error(`rubric not found: ${options.rubricRef ?? "radar"}`);
  }

  const baseGateway = createModelGateway();
  const gateway = options.cost
    ? attributedEvolutionGateway(
        baseGateway,
        evolutionCallScope(options.cost, "score"),
      )
    : baseGateway;
  let draft = "";
  let costCny = 0;
  let tokens = 0;
  const instructions = stripFrontmatter(
    await readFile(path.join(variant.dir, agent.spec.file), "utf8"),
  );

  if (options.stub) {
    draft = `[stub] ${agent.frontmatter.name}: ${evidence.slice(0, 80)}`;
  } else {
    const response = await gateway.complete({
      model: agent.frontmatter.model,
      instructions,
      input: evidence,
    });
    draft = response.text;
    costCny += response.usage.costCny ?? 0;
    tokens += response.usage.inputTokens + response.usage.outputTokens;
  }

  const deterministic = deterministicCheck(draft);
  let pass = deterministic.pass;
  let scores: Record<string, number> = {};
  let rationale = deterministic.reasons.join("; ");

  if (!options.stub) {
    const judge = await gateway.complete({
      model: "deepseek-pro",
      instructions: `You are an independent quality evaluator. Score the draft on these dimensions from 0 to 1: ${Object.keys(
        rubric.dimensions,
      ).join(
        ", ",
      )}. Verify that every [S#] citation exists in the evidence set. Return JSON only: {"scores":{"dimension":0.0},"rationale":"short"}.`,
      input: `Evidence set:\n${evidence}\n\nDraft:\n${draft}`,
    });
    costCny += judge.usage.costCny ?? 0;
    tokens += judge.usage.inputTokens + judge.usage.outputTokens;

    const parsed = parseJudge(judge.text);
    scores = parsed.scores;
    rationale = parsed.rationale || rationale;

    if (Object.keys(scores).length === 0) {
      pass = false;
    }

    for (const [name, config] of Object.entries(rubric.dimensions)) {
      const threshold =
        config.threshold > 1 ? config.threshold / 5 : config.threshold;
      if ((scores[name] ?? 0) < threshold) {
        pass = false;
      }
    }
  } else {
    scores = { deterministic: deterministic.pass ? 1 : 0 };
  }

  if (evalDir) {
    const hidden = await scoreHiddenCases({
      evalDir,
      agentName: agent.frontmatter.name,
      model: agent.frontmatter.model,
      instructions,
      stub: options.stub ?? false,
      gateway,
    });
    costCny += hidden.costCny;
    tokens += hidden.tokens;
    if (hidden.coverage.available) {
      const { passed, total, adversarialFailed } = hidden.coverage;
      scores = {
        ...scores,
        hidden: roundRatio(passed / total),
        hiddenAdversarial: adversarialFailed === 0 ? 1 : 0,
      };
      const adversarialNote =
        adversarialFailed > 0
          ? ` (${adversarialFailed} adversarial failed)`
          : "";
      rationale = appendNote(
        rationale,
        `hidden ${passed}/${total} passed${adversarialNote}`,
      );
      if (adversarialFailed > 0) {
        pass = false;
      }
    } else {
      rationale = appendNote(rationale, "hidden coverage unavailable");
    }
  }

  const record: EvolutionRecord = {
    variantId: meta.id,
    name: meta.name,
    parent: meta.parent,
    agentId,
    stub: options.stub ?? false,
    createdAt: new Date().toISOString(),
    pass,
    scores,
    rationale,
    costCny: Math.round(costCny * 10000) / 10000,
    tokens,
    draftChars: draft.length,
  };

  if (options.repo) {
    await options.repo.appendScore(record);
  } else {
    await appendArchive(options.archive ?? DEFAULT_ARCHIVE, record);
  }
  return record;
}

export async function compareVariants(
  archivePath = DEFAULT_ARCHIVE,
  repo?: EvolutionRepository,
): Promise<EvolutionRecord[]> {
  if (repo) {
    return await repo.latestScores();
  }
  if (!existsSync(archivePath)) {
    return [];
  }

  const lines = (await readFile(archivePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);

  const latest = new Map<string, EvolutionRecord>();
  for (const line of lines) {
    const record = JSON.parse(line) as EvolutionRecord;
    latest.set(record.variantId, record);
  }

  return [...latest.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export async function promoteVariant(
  variantDir: string,
  targetDir: string,
  apply: boolean,
  repo?: EvolutionRepository,
): Promise<{
  apply: boolean;
  files: string[];
  backupDir?: string;
}> {
  const diskMeta = await readVariantMeta(variantDir);
  let meta = diskMeta;
  let sourceDir = variantDir;
  let materialized: string | undefined;

  if (repo) {
    let stored = await repo.getVariant(diskMeta.id);
    if (!stored) {
      await repo.saveVariant({
        meta: diskMeta,
        dir: variantDir,
        packDir: path.resolve(targetDir),
      });
      stored = await repo.getVariant(diskMeta.id);
    }
    if (!stored) {
      throw new Error(`variant not registered in repository: ${diskMeta.id}`);
    }
    meta = stored.meta;
    materialized = await mkdtemp(
      path.join(os.tmpdir(), "kit-evolution-promote-"),
    );
    await repo.materializeVariant(meta.id, materialized);
    sourceDir = materialized;
  }

  try {
    await verifyLockedFiles(sourceDir, meta.baselineHashes);

    const variant = await loadPack(sourceDir);
    if (!variant.ok) {
      throw new Error(variant.errors.join("\n"));
    }
    const target = await loadPack(targetDir);
    if (!target.ok) {
      throw new Error(target.errors.join("\n"));
    }

    if (!apply) {
      return { apply: false, files: meta.changedFiles };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(target.dir, ".backup", "evolution", stamp);

    const run = async () => {
      const restore: Array<{ destination: string; backup?: string }> = [];
      try {
        for (const relative of meta.changedFiles) {
          const source = path.join(sourceDir, relative);
          const destination = path.join(target.dir, relative);
          const existed = existsSync(destination);
          const backup = path.join(backupDir, relative);
          if (existed) {
            await mkdir(path.dirname(backup), { recursive: true });
            await writeFile(backup, await readFile(destination));
          }
          const content = await readFile(source);
          await mkdir(path.dirname(destination), { recursive: true });
          const temp = `${destination}.${process.pid}.tmp`;
          await writeFile(temp, content);
          await rename(temp, destination);
          restore.push({ destination, ...(existed ? { backup } : {}) });
        }
      } catch (error) {
        for (const item of restore.reverse()) {
          try {
            if (item.backup) {
              await writeFile(item.destination, await readFile(item.backup));
            } else {
              await rm(item.destination, { force: true });
            }
          } catch {
            // best-effort restore; the backup directory remains for manual recovery
          }
        }
        throw error;
      }
      return { apply: true, files: meta.changedFiles, backupDir };
    };

    if (repo) {
      const result = await repo.withLock(
        `kit:evolution:promote:${path.resolve(target.dir)}`,
        run,
      );
      if (result === null) {
        throw new Error("timed out waiting for the evolution promotion lock");
      }
      return result;
    }
    return await run();
  } finally {
    if (materialized) {
      await rm(materialized, { recursive: true, force: true });
    }
  }
}

async function readVariantMeta(dir: string): Promise<VariantMeta> {
  const metaPath = path.join(dir, "variant.json");
  if (!existsSync(metaPath)) {
    throw new Error(`variant.json missing: ${dir}`);
  }
  return JSON.parse(await readFile(metaPath, "utf8")) as VariantMeta;
}

async function hashLockedFiles(dir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const relative of await listFiles(dir)) {
    if (
      relative === "variant.json" ||
      relative === "README.md" ||
      relative.startsWith("agents/")
    ) {
      continue;
    }
    const content = await readFile(path.join(dir, relative));
    hashes[relative] = createHash("sha256").update(content).digest("hex");
  }

  return hashes;
}

async function verifyLockedFiles(
  dir: string,
  baselineHashes: Record<string, string>,
): Promise<void> {
  for (const [relative, expected] of Object.entries(baselineHashes)) {
    const fullPath = path.join(dir, relative);
    if (!existsSync(fullPath)) {
      throw new Error(`locked file missing: ${relative}`);
    }
    const actual = createHash("sha256")
      .update(await readFile(fullPath))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(`locked file changed: ${relative}`);
    }
  }
}

async function listFiles(root: string, dir: string = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".backup") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFiles(root, fullPath)));
    } else if (entry.isFile()) {
      results.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }

  return results;
}

async function appendArchive(
  archivePath: string,
  record: EvolutionRecord,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(archivePath)), { recursive: true });
  await appendFile(archivePath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Visible evals live under `evals/visible/` (E2 layout). Packs authored before
 * the split keep the rubric directly under `evals/`; both resolve here.
 */
function resolveRubricPath(root: string, relative: string): string {
  const direct = path.join(root, relative);
  if (existsSync(direct)) {
    return direct;
  }
  const legacyRelative = relative.replace(/^evals\/visible\//, "evals/");
  if (legacyRelative !== relative) {
    const legacy = path.join(root, legacyRelative);
    if (existsSync(legacy)) {
      return legacy;
    }
  }
  return direct;
}

/**
 * Runs the rotated hidden subset against the agent. Only aggregate coverage
 * leaves this function; case evidence and ids stay in the external snapshot
 * and audit sink.
 */
async function scoreHiddenCases(input: {
  evalDir: string;
  agentName: string;
  model: string;
  instructions: string;
  stub: boolean;
  gateway: ReturnType<typeof createModelGateway>;
}): Promise<{ coverage: HiddenCoverage; costCny: number; tokens: number }> {
  const snapshot = await readEvalSnapshotManifest(input.evalDir);
  const plan = snapshot.manifest.hidden;
  if (!plan || !plan.available) {
    return { coverage: { ...EMPTY_HIDDEN_COVERAGE }, costCny: 0, tokens: 0 };
  }

  const suite = await loadHiddenSuite(path.join(input.evalDir, "hidden"));
  if (suite.suiteHash !== plan.suiteHash) {
    throw new Error("hidden eval suite changed after the snapshot was frozen");
  }
  const byId = new Map(suite.cases.map((item) => [item.id, item]));
  const cases: HiddenCase[] = [];
  for (const id of plan.selectedCaseIds) {
    const found = byId.get(id);
    if (!found) {
      throw new Error("hidden eval suite is missing a rotated case");
    }
    cases.push(found);
  }

  await appendHiddenAudit(auditRootForSnapshot(input.evalDir), {
    at: new Date().toISOString(),
    action: "score",
    cycleId: snapshot.manifest.cycleId,
    suiteHash: plan.suiteHash,
    rotationEpoch: plan.rotationEpoch,
    selectedCaseIds: plan.selectedCaseIds,
  });

  let passed = 0;
  let adversarialFailed = 0;
  let costCny = 0;
  let tokens = 0;
  for (const item of cases) {
    let draft = `[stub] ${input.agentName}: ${item.evidence.slice(0, 80)}`;
    if (!input.stub) {
      const response = await input.gateway.complete({
        model: input.model,
        instructions: input.instructions,
        input: item.evidence,
      });
      draft = response.text;
      costCny += response.usage.costCny ?? 0;
      tokens += response.usage.inputTokens + response.usage.outputTokens;
    }
    if (checkHiddenDraft(draft, item.expect)) {
      passed += 1;
    } else if (item.kind === "adversarial") {
      adversarialFailed += 1;
    }
  }

  return {
    coverage: {
      available: true,
      total: cases.length,
      passed,
      failed: cases.length - passed,
      adversarialFailed,
    },
    costCny,
    tokens,
  };
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function appendNote(base: string, note: string): string {
  return base ? `${base}; ${note}` : note;
}

function parseFrontmatter(text: string): string | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1];
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function deterministicCheck(text: string): {
  pass: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (text.trim().length < 20) {
    reasons.push("output shorter than 20 characters");
  }
  if (/\bTODO\b/i.test(text)) {
    reasons.push("contains TODO");
  }
  if (/\{\{[^}]+\}\}/.test(text)) {
    reasons.push("contains unresolved template placeholder");
  }
  return { pass: reasons.length === 0, reasons };
}

function parseJudge(text: string): {
  scores: Record<string, number>;
  rationale: string;
} {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      scores?: Record<string, unknown>;
      rationale?: unknown;
    };
    const scores: Record<string, number> = {};
    for (const [name, value] of Object.entries(parsed.scores ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        scores[name] = value;
      }
    }
    return {
      scores,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    return { scores: {}, rationale: "invalid judge response" };
  }
}
