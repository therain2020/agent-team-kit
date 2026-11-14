import {
  type EvidenceDocument,
  type IterationFailure,
  evidenceFromIterations,
  evidenceFromSignals,
  mergeEvidence,
  readIterationSignals,
} from "@kit/evolution";
import { ensureStoreSchema, getStore } from "./store";

export interface EvidenceResolution {
  document: EvidenceDocument;
  text: string;
  generated: boolean;
  sources: number;
}

interface FailedTaskRow {
  iteration_id: string;
  task_id: string;
  domain: string;
  goal: string;
  acceptance: string | null;
  error: string | null;
  updated_at: Date | string;
}

const MAX_EVIDENCE_CHARS = 200_000;

/**
 * Manual JSON wins; otherwise evidence is rebuilt from recent failed
 * iterations and iteration signals so evaluation never needs hand-edited
 * fixture files.
 */
export async function resolveEvolutionEvidence(
  raw: unknown,
): Promise<EvidenceResolution> {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const text = raw.trim();
    if (text.length > MAX_EVIDENCE_CHARS) {
      throw new Error("evidenceText exceeds 200k characters");
    }
    return parseManualEvidence(text);
  }

  const [failures, signals] = await Promise.all([
    readFailedIterations(),
    readIterationSignals(),
  ]);
  const document = mergeEvidence([
    evidenceFromIterations(failures),
    evidenceFromSignals(signals),
  ]);
  if (document.sources.length === 0) {
    throw new Error(
      "no evidence available: paste evidence JSON or run a failed iteration first",
    );
  }
  return {
    document,
    text: JSON.stringify(document, null, 2),
    generated: true,
    sources: document.sources.length,
  };
}

function parseManualEvidence(text: string): EvidenceResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("evidenceText must be valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { sources?: unknown }).sources)
  ) {
    throw new Error("evidence must contain a sources[] array");
  }
  const document = parsed as EvidenceDocument;
  return {
    document,
    text,
    generated: false,
    sources: document.sources.length,
  };
}

async function readFailedIterations(): Promise<IterationFailure[]> {
  await ensureStoreSchema();
  const store = getStore();
  const rows = await store.sql<FailedTaskRow[]>`
    SELECT t.iteration_id, t.task_id, t.domain, t.goal, t.acceptance, t.error, t.updated_at
    FROM iteration_tasks t
    JOIN iteration_runs r ON r.iteration_id = t.iteration_id
    WHERE r.workspace_id = 'default' AND t.status = 'failed'
    ORDER BY t.updated_at DESC
    LIMIT 20
  `;
  return rows
    .map((row) => ({
      iterationId: row.iteration_id,
      taskId: row.task_id,
      domain: row.domain,
      goal: row.goal,
      acceptance: row.acceptance,
      error: row.error,
      updatedAt: toIso(row.updated_at),
    }))
    .reverse();
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
