import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { newId } from "@kit/core";
import { type initStore, withStoreLock } from "@kit/store";
import type { CanaryState } from "./canary";
import type { EvolutionCycleRecord } from "./cycle";
import type { EvolutionRecord, VariantMeta } from "./evolve";
import type {
  EvolutionRepository,
  StoredCanaryState,
  StoredVariant,
} from "./repository";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface StoreEvolutionOptions {
  workspaceId?: string;
  variantsRoot?: string;
  archivePath?: string;
  cyclesPath?: string;
  statePath?: string;
}

interface VariantRow {
  variant_id: string;
  name: string;
  parent_id: string | null;
  agent_id: string;
  pack_dir: string;
  dir_path: string;
  meta: VariantMeta | string;
  status: string;
  created_at: Date | string;
}

interface ScoreRow {
  score_id: string;
  variant_id: string;
  pass: boolean;
  scores: Record<string, number> | string;
  rationale: string;
  cost_cny: string | number;
  tokens: number;
  draft_chars: number;
  stub: boolean;
  created_at: Date | string;
  variant_name?: string;
  variant_agent?: string;
  variant_parent?: string | null;
}

interface CycleRow {
  cycle_id: string;
  pack_dir: string;
  agent_id: string;
  hypothesis: string;
  signals: string[] | string;
  baseline_variant_id: string | null;
  candidate_variant_id: string | null;
  baseline_name: string;
  candidate_name: string;
  baseline_pass: boolean | null;
  candidate_pass: boolean | null;
  baseline_score: number | null;
  candidate_score: number | null;
  cost_cny: string | number;
  decision: string;
  rationale: string;
  auto_applied: boolean;
  error: string | null;
  eval_snapshot_path: string | null;
  eval_snapshot_hash: string | null;
  evaluator_hash: string | null;
  evaluator_approval_ref: string | null;
  created_at: Date | string;
}

interface StateRow {
  champion_variant_id: string;
  canary_variant_id: string | null;
  canary_status: string | null;
  canary_percent: number | null;
  canary_since: Date | string | null;
  canary_reason: string | null;
  canary_eval_snapshot_path: string | null;
  version: number;
}

export class StoreEvolutionRepository implements EvolutionRepository {
  readonly kind: "postgres" | "sqlite";
  private readonly workspaceId: string;
  private readonly variantsRoot: string;
  private readonly archivePath: string;
  private readonly cyclesPath: string;
  private readonly statePath: string;
  private imported?: Promise<void>;

  constructor(
    private readonly store: Store,
    options: StoreEvolutionOptions = {},
  ) {
    this.kind = store.driver;
    this.workspaceId = options.workspaceId ?? "default";
    this.variantsRoot = path.resolve(options.variantsRoot ?? "variants");
    this.archivePath = path.resolve(
      options.archivePath ?? path.join(this.variantsRoot, "archive.jsonl"),
    );
    this.cyclesPath = path.resolve(
      options.cyclesPath ?? path.join(this.variantsRoot, "cycles.jsonl"),
    );
    this.statePath = path.resolve(
      options.statePath ?? path.join(this.variantsRoot, "state.json"),
    );
  }

  async ensureReady(): Promise<void> {
    this.imported ??= this.importLegacy().catch((error) => {
      this.imported = undefined;
      throw error;
    });
    await this.imported;
  }

  async saveVariant(input: {
    meta: VariantMeta;
    dir: string;
    packDir?: string;
  }): Promise<void> {
    await this.ensureReady();
    await this.persistVariant(input.meta, input.dir, input.packDir ?? "");
  }

  async getVariant(ref: string): Promise<StoredVariant | null> {
    await this.ensureReady();
    const isId = /^var_/.test(ref);
    const rows = await this.store.sql<VariantRow[]>`
      SELECT * FROM evolution_variants
      WHERE workspace_id = ${this.workspaceId}
        AND ${isId ? this.store.sql`variant_id = ${ref}` : this.store.sql`dir_path = ${path.resolve(ref)}`}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? mapVariant(row) : null;
  }

  async listVariants(packDir?: string): Promise<StoredVariant[]> {
    await this.ensureReady();
    const rows = packDir
      ? await this.store.sql<VariantRow[]>`
          SELECT * FROM evolution_variants
          WHERE workspace_id = ${this.workspaceId} AND pack_dir = ${packDir}
          ORDER BY created_at ASC
        `
      : await this.store.sql<VariantRow[]>`
          SELECT * FROM evolution_variants
          WHERE workspace_id = ${this.workspaceId}
          ORDER BY created_at ASC
        `;
    return rows.map(mapVariant);
  }

  async materializeVariant(variantId: string, destDir: string): Promise<void> {
    await this.ensureReady();
    const files = await this.store.sql<
      Array<{ path: string; sha256: string; storage_key: string }>
    >`
      SELECT f.path, f.sha256, b.storage_key
      FROM evolution_variant_files f
      JOIN blobs b ON b.blob_id = f.blob_id
      WHERE f.variant_id = ${variantId}
      ORDER BY f.path ASC
    `;
    if (files.length === 0) {
      throw new Error(`variant has no stored files: ${variantId}`);
    }
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    for (const file of files) {
      const bytes = await this.store.blobClient.get(file.storage_key);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== file.sha256) {
        throw new Error(`blob hash mismatch for ${file.path}`);
      }
      const target = path.join(destDir, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, target);
    }
  }

  async appendScore(record: EvolutionRecord): Promise<void> {
    await this.ensureReady();
    await this.appendScoreInternal(record);
  }

  async listScores(variantId?: string): Promise<EvolutionRecord[]> {
    await this.ensureReady();
    const rows = variantId
      ? await this.store.sql<ScoreRow[]>`
          SELECT s.*, v.name AS variant_name, v.agent_id AS variant_agent,
                 v.parent_id AS variant_parent
          FROM evolution_scores s
          LEFT JOIN evolution_variants v ON v.variant_id = s.variant_id
          WHERE s.variant_id = ${variantId}
            AND v.workspace_id = ${this.workspaceId}
          ORDER BY s.created_at ASC
        `
      : await this.store.sql<ScoreRow[]>`
          SELECT s.*, v.name AS variant_name, v.agent_id AS variant_agent,
                 v.parent_id AS variant_parent
          FROM evolution_scores s
          LEFT JOIN evolution_variants v ON v.variant_id = s.variant_id
          WHERE v.workspace_id = ${this.workspaceId}
          ORDER BY s.created_at ASC
        `;
    return rows.map(mapScore);
  }

  async latestScores(): Promise<EvolutionRecord[]> {
    await this.ensureReady();
    const rows = await this.store.sql<ScoreRow[]>`
      SELECT s.*, v.name AS variant_name, v.agent_id AS variant_agent,
             v.parent_id AS variant_parent
      FROM evolution_scores s
      LEFT JOIN evolution_variants v ON v.variant_id = s.variant_id
      WHERE v.workspace_id = ${this.workspaceId}
        AND s.score_id = (
          SELECT s2.score_id FROM evolution_scores s2
          WHERE s2.variant_id = s.variant_id
          ORDER BY s2.created_at DESC, s2.score_id DESC
          LIMIT 1
        )
      ORDER BY s.created_at ASC
    `;
    return rows
      .map(mapScore)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendCycle(record: EvolutionCycleRecord): Promise<void> {
    await this.ensureReady();
    await this.appendCycleInternal(record);
  }

  async listCycles(limit = 50): Promise<EvolutionCycleRecord[]> {
    await this.ensureReady();
    const rows = await this.store.sql<CycleRow[]>`
      SELECT * FROM evolution_cycles
      WHERE workspace_id = ${this.workspaceId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapCycle);
  }

  async getState(): Promise<StoredCanaryState | null> {
    await this.ensureReady();
    const rows = await this.store.sql<StateRow[]>`
      SELECT * FROM evolution_state
      WHERE workspace_id = ${this.workspaceId} AND pack_dir = ''
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    const champion = await this.getVariant(row.champion_variant_id);
    if (!champion) {
      return null;
    }
    const state: CanaryState = {
      champion: { path: champion.dir },
    };
    if (row.canary_variant_id && row.canary_status) {
      const canary = await this.getVariant(row.canary_variant_id);
      if (canary) {
        state.canary = {
          path: canary.dir,
          variantId: canary.meta.id,
          agentId: canary.meta.agentId,
          percent: row.canary_percent ?? 20,
          status: row.canary_status as "active" | "rolled_back" | "promoted",
          since: toIso(row.canary_since) ?? new Date().toISOString(),
          ...(row.canary_reason ? { reason: row.canary_reason } : {}),
          ...(row.canary_eval_snapshot_path
            ? { evalSnapshotPath: row.canary_eval_snapshot_path }
            : {}),
        };
      }
    }
    return { state, version: row.version };
  }

  async setState(
    state: CanaryState,
    expectedVersion?: number,
  ): Promise<boolean> {
    await this.ensureReady();
    return await this.setStateInternal(state, expectedVersion);
  }

  private async setStateInternal(
    state: CanaryState,
    expectedVersion?: number,
  ): Promise<boolean> {
    const championId = await this.variantIdByDir(state.champion.path);
    if (!championId) {
      throw new Error(`unknown champion path: ${state.champion.path}`);
    }
    const canaryId = state.canary
      ? await this.variantIdByDir(state.canary.path)
      : null;
    if (state.canary && !canaryId) {
      throw new Error(`unknown canary path: ${state.canary.path}`);
    }
    const now = new Date().toISOString();
    const canary = state.canary;
    if (expectedVersion === undefined) {
      await this.store.sql`
        INSERT INTO evolution_state (
          workspace_id, pack_dir, champion_variant_id, canary_variant_id,
          canary_status, canary_percent, canary_since, canary_reason,
          canary_eval_snapshot_path, version, updated_at
        ) VALUES (
          ${this.workspaceId}, '', ${championId}, ${canaryId},
          ${canary?.status ?? null}, ${canary?.percent ?? null},
          ${canary?.since ?? null}, ${canary?.reason ?? null},
          ${canary?.evalSnapshotPath ?? null}, 0, ${now}
        )
        ON CONFLICT (workspace_id, pack_dir) DO UPDATE SET
          champion_variant_id = EXCLUDED.champion_variant_id,
          canary_variant_id = EXCLUDED.canary_variant_id,
          canary_status = EXCLUDED.canary_status,
          canary_percent = EXCLUDED.canary_percent,
          canary_since = EXCLUDED.canary_since,
          canary_reason = EXCLUDED.canary_reason,
          canary_eval_snapshot_path = EXCLUDED.canary_eval_snapshot_path,
          version = evolution_state.version + 1,
          updated_at = EXCLUDED.updated_at
      `;
      return true;
    }
    const rows = await this.store.sql<Array<{ version: number }>>`
      UPDATE evolution_state SET
        champion_variant_id = ${championId},
        canary_variant_id = ${canaryId},
        canary_status = ${canary?.status ?? null},
        canary_percent = ${canary?.percent ?? null},
        canary_since = ${canary?.since ?? null},
        canary_reason = ${canary?.reason ?? null},
        canary_eval_snapshot_path = ${canary?.evalSnapshotPath ?? null},
        version = version + 1,
        updated_at = ${now}
      WHERE workspace_id = ${this.workspaceId}
        AND pack_dir = '' AND version = ${expectedVersion}
      RETURNING version
    `;
    return rows.length > 0;
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    return await withStoreLock(this.store, key, fn);
  }

  private async persistVariant(
    meta: VariantMeta,
    dir: string,
    packDir: string,
  ): Promise<void> {
    const dirPath = path.resolve(dir);
    const files = await listVariantFiles(dirPath);
    const rows: Array<{
      path: string;
      blobId: string;
      sha256: string;
      size: number;
    }> = [];
    for (const relative of files) {
      const bytes = await readFile(path.join(dirPath, relative));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const blob = await this.ensureBlob(bytes, sha256);
      rows.push({
        path: relative,
        blobId: blob.blobId,
        sha256,
        size: bytes.length,
      });
    }

    await this.store.sql.begin(async (tx) => {
      await tx`
        INSERT INTO evolution_variants (
          variant_id, workspace_id, name, parent_id, agent_id, pack_dir,
          dir_path, meta, status, created_at
        ) VALUES (
          ${meta.id}, ${this.workspaceId}, ${meta.name}, ${meta.parent},
          ${meta.agentId}, ${packDir}, ${dirPath},
          ${tx.json(meta)}, 'active', ${meta.createdAt}
        )
        ON CONFLICT (variant_id) DO UPDATE SET
          name = EXCLUDED.name,
          parent_id = EXCLUDED.parent_id,
          agent_id = EXCLUDED.agent_id,
          pack_dir = EXCLUDED.pack_dir,
          dir_path = EXCLUDED.dir_path,
          meta = EXCLUDED.meta,
          status = EXCLUDED.status
      `;
      await tx`DELETE FROM evolution_variant_files WHERE variant_id = ${meta.id}`;
      for (const row of rows) {
        await tx`
          INSERT INTO evolution_variant_files (
            variant_id, path, blob_id, sha256, size
          ) VALUES (
            ${meta.id}, ${row.path}, ${row.blobId}, ${row.sha256}, ${row.size}
          )
        `;
      }
    });
  }

  private async ensureBlob(
    bytes: Uint8Array,
    sha256: string,
  ): Promise<{ blobId: string; storageKey: string }> {
    const existing = await this.store.blobs.find(this.workspaceId, sha256);
    if (existing) {
      return { blobId: existing.blobId, storageKey: existing.storageKey };
    }
    const blobId = newId("blb");
    const storageKey = `evolution/${this.workspaceId}/${sha256}`;
    await this.store.blobClient.put(storageKey, bytes);
    await this.store.blobs.insert({
      blobId,
      workspaceId: this.workspaceId,
      sha256,
      size: bytes.length,
      storageKey,
      createdAt: new Date().toISOString(),
    });
    const raced = await this.store.blobs.find(this.workspaceId, sha256);
    const blob = raced ?? (await this.store.blobs.findById(blobId));
    if (!blob) {
      throw new Error(`failed to persist blob ${sha256}`);
    }
    return { blobId: blob.blobId, storageKey: blob.storageKey };
  }

  private async appendScoreInternal(record: EvolutionRecord): Promise<void> {
    const meta: VariantMeta = {
      id: record.variantId,
      name: record.name,
      parent: record.parent,
      agentId: record.agentId,
      model: "",
      createdAt: record.createdAt,
      baselineHashes: {},
      changedFiles: [],
    };
    await this.store.sql`
      INSERT INTO evolution_variants (
        variant_id, workspace_id, name, parent_id, agent_id, pack_dir,
        dir_path, meta, status, created_at
      ) VALUES (
        ${record.variantId}, ${this.workspaceId}, ${record.name},
        ${record.parent}, ${record.agentId}, '', '', ${this.store.sql.json(meta)},
        'active', ${record.createdAt}
      )
      ON CONFLICT (variant_id) DO NOTHING
    `;
    await this.store.sql`
      INSERT INTO evolution_scores (
        score_id, variant_id, pass, scores, rationale, cost_cny, tokens,
        draft_chars, stub, created_at
      ) VALUES (
        ${newId("scr")}, ${record.variantId}, ${record.pass},
        ${this.store.sql.json(record.scores)}, ${record.rationale},
        ${record.costCny}, ${record.tokens}, ${record.draftChars},
        ${record.stub}, ${record.createdAt}
      )
    `;
  }

  private async appendCycleInternal(
    record: EvolutionCycleRecord,
  ): Promise<void> {
    const baselineId = record.baselineName
      ? await this.variantIdByName(record.baselineName)
      : null;
    const candidateId = record.candidateName
      ? await this.variantIdByName(record.candidateName)
      : null;
    await this.store.sql`
      INSERT INTO evolution_cycles (
        cycle_id, workspace_id, pack_dir, agent_id, hypothesis, signals,
        baseline_variant_id, candidate_variant_id, baseline_name, candidate_name,
        baseline_pass, candidate_pass, baseline_score, candidate_score,
        cost_cny, decision, rationale, auto_applied, error,
        eval_snapshot_path, eval_snapshot_hash, evaluator_hash,
        evaluator_approval_ref, created_at
      ) VALUES (
        ${record.cycleId}, ${this.workspaceId}, ${record.packDir}, ${record.agentId},
        ${record.hypothesis}, ${this.store.sql.json(record.signals)},
        ${baselineId}, ${candidateId}, ${record.baselineName},
        ${record.candidateName}, ${record.baselinePass}, ${record.candidatePass},
        ${record.baselineScore}, ${record.candidateScore}, ${record.costCny},
        ${record.decision}, ${record.rationale}, ${record.autoApplied},
        ${record.error ?? null}, ${record.evalSnapshotPath ?? null},
        ${record.evalSnapshotHash ?? null}, ${record.evaluatorHash ?? null},
        ${record.evaluatorApprovalRef ?? null}, ${record.createdAt}
      )
      ON CONFLICT (cycle_id) DO NOTHING
    `;
  }

  private async variantIdByName(name: string): Promise<string | null> {
    const rows = await this.store.sql<Array<{ variant_id: string }>>`
      SELECT variant_id FROM evolution_variants
      WHERE workspace_id = ${this.workspaceId} AND name = ${name}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0]?.variant_id ?? null;
  }

  private async variantIdByDir(dir: string): Promise<string | null> {
    const rows = await this.store.sql<Array<{ variant_id: string }>>`
      SELECT variant_id FROM evolution_variants
      WHERE workspace_id = ${this.workspaceId}
        AND dir_path = ${path.resolve(dir)}
      LIMIT 1
    `;
    return rows[0]?.variant_id ?? null;
  }

  private async importLegacy(): Promise<void> {
    const marker = await this.store.sql<Array<unknown>>`
      SELECT 1 FROM evolution_meta
      WHERE workspace_id = ${this.workspaceId} AND key = 'imported_at'
      LIMIT 1
    `;
    if (marker.length > 0) {
      return;
    }
    const imported = await withStoreLock(
      this.store,
      `kit:evolution:import:${this.workspaceId}`,
      async () => {
        const again = await this.store.sql<Array<unknown>>`
          SELECT 1 FROM evolution_meta
          WHERE workspace_id = ${this.workspaceId} AND key = 'imported_at'
          LIMIT 1
        `;
        if (again.length > 0) {
          return true;
        }

        let importedAny = false;
        if (existsSync(this.variantsRoot)) {
          const entries = await readdir(this.variantsRoot, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            if (!entry.isDirectory()) {
              continue;
            }
            const dir = path.join(this.variantsRoot, entry.name);
            const metaPath = path.join(dir, "variant.json");
            if (!existsSync(metaPath)) {
              continue;
            }
            const meta = JSON.parse(
              await readFile(metaPath, "utf8"),
            ) as VariantMeta;
            await this.persistVariant(meta, dir, "");
            importedAny = true;
          }
        }

        const scoreCount = await this.store.sql<Array<{ count: string }>>`
          SELECT count(*) AS count
          FROM evolution_scores s
          JOIN evolution_variants v ON v.variant_id = s.variant_id
          WHERE v.workspace_id = ${this.workspaceId}
        `;
        if (Number(scoreCount[0]?.count ?? 0) === 0) {
          const records = await readJsonl<EvolutionRecord>(this.archivePath);
          for (const record of records) {
            await this.appendScoreInternal(record);
          }
          if (records.length > 0) {
            importedAny = true;
          }
        }

        const cycleCount = await this.store.sql<Array<{ count: string }>>`
          SELECT count(*) AS count FROM evolution_cycles
          WHERE workspace_id = ${this.workspaceId}
        `;
        if (Number(cycleCount[0]?.count ?? 0) === 0) {
          const records = await readJsonl<EvolutionCycleRecord>(
            this.cyclesPath,
          );
          for (const record of records) {
            await this.appendCycleInternal(record);
          }
          if (records.length > 0) {
            importedAny = true;
          }
        }

        const stateCount = await this.store.sql<Array<{ count: string }>>`
          SELECT count(*) AS count FROM evolution_state
          WHERE workspace_id = ${this.workspaceId}
        `;
        if (
          Number(stateCount[0]?.count ?? 0) === 0 &&
          existsSync(this.statePath)
        ) {
          const state = JSON.parse(
            await readFile(this.statePath, "utf8"),
          ) as CanaryState;
          await this.setStateInternal(state);
          importedAny = true;
        }

        if (!importedAny) {
          return true;
        }

        await this.store.sql`
          INSERT INTO evolution_meta (workspace_id, key, value, updated_at)
          VALUES (
            ${this.workspaceId}, 'imported_at',
            ${this.store.sql.json({
              variantsRoot: this.variantsRoot,
              archivePath: this.archivePath,
              cyclesPath: this.cyclesPath,
              statePath: this.statePath,
            })},
            ${new Date().toISOString()}
          )
          ON CONFLICT (workspace_id, key) DO NOTHING
        `;
        return true;
      },
    );
    if (imported === null) {
      throw new Error("timed out waiting for evolution import lock");
    }
  }
}

function mapVariant(row: VariantRow): StoredVariant {
  const meta =
    typeof row.meta === "string"
      ? (JSON.parse(row.meta) as VariantMeta)
      : row.meta;
  return {
    meta: {
      ...meta,
      id: row.variant_id,
      name: row.name,
      parent: row.parent_id,
      agentId: row.agent_id,
    },
    dir: row.dir_path,
  };
}

function mapScore(row: ScoreRow): EvolutionRecord {
  return {
    variantId: row.variant_id,
    name: row.variant_name ?? "",
    parent: row.variant_parent ?? null,
    agentId: row.variant_agent ?? "",
    stub: Boolean(row.stub),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    pass: Boolean(row.pass),
    scores:
      typeof row.scores === "string"
        ? (JSON.parse(row.scores) as Record<string, number>)
        : row.scores,
    rationale: row.rationale,
    costCny: Number(row.cost_cny),
    tokens: Number(row.tokens),
    draftChars: Number(row.draft_chars),
  };
}

function mapCycle(row: CycleRow): EvolutionCycleRecord {
  return {
    cycleId: row.cycle_id,
    packDir: row.pack_dir,
    agentId: row.agent_id,
    hypothesis: row.hypothesis,
    signals:
      typeof row.signals === "string"
        ? (JSON.parse(row.signals) as string[])
        : row.signals,
    baselineName: row.baseline_name,
    candidateName: row.candidate_name,
    baselinePass:
      row.baseline_pass === null || row.baseline_pass === undefined
        ? null
        : Boolean(row.baseline_pass),
    candidatePass:
      row.candidate_pass === null || row.candidate_pass === undefined
        ? null
        : Boolean(row.candidate_pass),
    baselineScore: row.baseline_score,
    candidateScore: row.candidate_score,
    costCny: Number(row.cost_cny),
    decision: row.decision as EvolutionCycleRecord["decision"],
    rationale: row.rationale,
    autoApplied: Boolean(row.auto_applied),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    ...(row.error ? { error: row.error } : {}),
    ...(row.eval_snapshot_path
      ? { evalSnapshotPath: row.eval_snapshot_path }
      : {}),
    ...(row.eval_snapshot_hash
      ? { evalSnapshotHash: row.eval_snapshot_hash }
      : {}),
    ...(row.evaluator_hash ? { evaluatorHash: row.evaluator_hash } : {}),
    ...(row.evaluator_approval_ref
      ? { evaluatorApprovalRef: row.evaluator_approval_ref }
      : {}),
  };
}

async function listVariantFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".backup" || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        results.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(root);
  return results.sort();
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) {
    return [];
  }
  const text = await readFile(file, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}
