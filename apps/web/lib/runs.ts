import type { ArtifactVersion, Blob, Manifest, Run, Stage } from "@kit/core";
import { cache } from "react";
import { getStore } from "./store";

type Store = Awaited<ReturnType<typeof getStore>>;

export type ArtifactKind =
  | "report"
  | "gate"
  | "revision"
  | "approval"
  | "manager"
  | "tool"
  | "instructions"
  | "transcript"
  | "artifact";

export interface ArtifactView {
  artifact: ArtifactVersion;
  manifest: Manifest | null;
  blob: Blob | null;
  kind: ArtifactKind;
}

export interface GateResult {
  stageId: string;
  attempt: number;
  pass: boolean;
  scores: Record<string, number>;
  thresholds: Record<string, number>;
  rationale: string;
  summary: string;
  judgeModel: string;
  costCny: number;
}

export interface ApprovalView {
  requestId: string;
  runId: string;
  stageId: string;
  stageName: string;
  requestType:
    | "stage_before"
    | "stage_after"
    | "gate_failure"
    | "budget_exceeded";
  draftArtifactId: string | null;
  summary: string;
  options: string[];
  expiresAt: string;
  artifact: ArtifactVersion;
  riskClass?: "low" | "medium" | "high";
  requestedBy: string;
  draftVersion: number;
  gateRefs: Array<{ artifactId: string; version: number }>;
}

/**
 * Per-stage glass-box evidence (30 §3.3). Artifact ids are null and counts are
 * zero when a stage ran before dossiers existed or the best-effort write failed.
 */
export interface StageDossier {
  instructionsArtifactId: string | null;
  transcriptArtifactId: string | null;
  gateScore: number | null;
  toolCalls: number;
}

export interface RunDetail {
  run: Run;
  stages: Stage[];
  artifacts: ArtifactView[];
  gates: GateResult[];
  approval: ApprovalView | null;
  decisions: ArtifactView[];
  costCny: number;
  tokens: number;
  report: ArtifactView | null;
  /** Keyed by `Stage.stageId`; every stage has an entry. */
  stageDossiers: Record<string, StageDossier>;
}

export interface RunSummary {
  run: Run;
  costCny: number;
  tokens: number;
  artifactCount: number;
}

export function classifyArtifact(manifest: Manifest | null): ArtifactKind {
  if (!manifest) {
    return "artifact";
  }
  const stageId = manifest.stageId;
  if (stageId.endsWith(":instructions") && !stageId.includes(":coder:")) {
    return "instructions";
  }
  if (stageId.endsWith(":transcript") && !stageId.includes(":coder:")) {
    return "transcript";
  }
  if (stageId.includes(":approval-request")) {
    return "approval";
  }
  if (stageId.includes(":gate:")) {
    return "gate";
  }
  if (stageId.includes(":revision-")) {
    return "revision";
  }
  if (stageId.includes(":tool:")) {
    return "tool";
  }
  if (stageId.includes(":manager-")) {
    return "manager";
  }
  if (stageId.endsWith(":deliver") || stageId.includes(":synthesize")) {
    return "report";
  }
  return "artifact";
}

export const loadRunDetail = cache(async function loadRunDetail(
  runId: string,
  store?: Store,
): Promise<RunDetail | null> {
  const client = store ?? (await getStore());
  const run = await client.runs.get(runId);
  if (!run) {
    return null;
  }

  const [stages, artifacts] = await Promise.all([
    client.stages.listByRun(runId),
    client.artifactStore.listByRun(runId),
  ]);

  const views: ArtifactView[] = await Promise.all(
    artifacts.map(async (artifact) => {
      const [manifest, blob] = await Promise.all([
        client.manifests.get(artifact.manifestId),
        client.blobs.findById(artifact.blobId),
      ]);
      return {
        artifact,
        manifest,
        blob,
        kind: classifyArtifact(manifest),
      };
    }),
  );

  const ordered = [...views].sort((a, b) =>
    a.artifact.createdAt.localeCompare(b.artifact.createdAt),
  );

  const gates: GateResult[] = [];
  for (const view of ordered) {
    if (view.kind !== "gate") {
      continue;
    }
    const parsed = await readJson(client, view);
    if (!parsed) {
      continue;
    }
    gates.push({
      stageId: view.manifest?.stageId ?? "unknown",
      attempt: Number(parsed.attempt ?? 0),
      pass: parsed.pass === true,
      scores:
        typeof parsed.scores === "object" && parsed.scores !== null
          ? (parsed.scores as Record<string, number>)
          : {},
      thresholds:
        typeof parsed.thresholds === "object" && parsed.thresholds !== null
          ? (parsed.thresholds as Record<string, number>)
          : {},
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      judgeModel:
        typeof parsed.judgeModel === "string" ? parsed.judgeModel : "unknown",
      costCny: view.manifest?.cost.amount ?? 0,
    });
  }

  let approval: ApprovalView | null = null;
  const approvalView = [...ordered]
    .reverse()
    .find((view) => view.kind === "approval");
  if (approvalView) {
    const parsed = await readJson(client, approvalView);
    if (parsed) {
      approval = {
        requestId: String(parsed.requestId ?? "unknown"),
        runId: String(parsed.runId ?? runId),
        stageId: String(parsed.stageId ?? ""),
        stageName: String(parsed.stageName ?? ""),
        requestType:
          parsed.requestType === "stage_before" ||
          parsed.requestType === "stage_after" ||
          parsed.requestType === "budget_exceeded"
            ? parsed.requestType
            : "gate_failure",
        draftArtifactId:
          typeof parsed.draftArtifactId === "string"
            ? parsed.draftArtifactId
            : null,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        options: Array.isArray(parsed.options)
          ? parsed.options.filter(
              (option): option is string => typeof option === "string",
            )
          : ["approve", "abort"],
        expiresAt: String(parsed.expiresAt ?? ""),
        artifact: approvalView.artifact,
        riskClass:
          parsed.riskClass === "low" ||
          parsed.riskClass === "medium" ||
          parsed.riskClass === "high"
            ? parsed.riskClass
            : undefined,
        requestedBy:
          typeof parsed.requestedBy === "string"
            ? parsed.requestedBy
            : "manager",
        draftVersion:
          typeof parsed.draftVersion === "number" ? parsed.draftVersion : 1,
        gateRefs: Array.isArray(parsed.gateRefs)
          ? parsed.gateRefs.flatMap((ref) => {
              if (
                typeof ref === "object" &&
                ref !== null &&
                typeof (ref as { artifactId?: unknown }).artifactId === "string"
              ) {
                const value = ref as {
                  artifactId: string;
                  version?: unknown;
                };
                return [
                  {
                    artifactId: value.artifactId,
                    version:
                      typeof value.version === "number" ? value.version : 1,
                  },
                ];
              }
              return [];
            })
          : [],
      };
    }
  }

  const costCny = ordered.reduce(
    (sum, view) => sum + (view.manifest?.cost.amount ?? 0),
    0,
  );
  const tokens = ordered.reduce(
    (sum, view) => sum + (view.manifest?.cost.tokens ?? 0),
    0,
  );

  const report =
    [...ordered]
      .reverse()
      .find(
        (view) =>
          view.kind === "report" ||
          (view.manifest?.stageId.endsWith(":deliver") ?? false),
      ) ?? null;

  const orderedStages = orderStages(stages);
  const stageDossiers = await buildStageDossiers(
    client,
    orderedStages,
    ordered,
  );

  return {
    run,
    stages: orderedStages,
    artifacts: ordered,
    gates,
    approval,
    decisions: ordered.filter(
      (view) => view.manifest?.stageId.includes(":manager-decision-") ?? false,
    ),
    costCny,
    tokens,
    report,
    stageDossiers,
  };
});

async function buildStageDossiers(
  store: Store,
  stages: Stage[],
  artifacts: ArtifactView[],
): Promise<Record<string, StageDossier>> {
  const dossiers = new Map<string, StageDossier>();
  const ensure = (stageId: string): StageDossier => {
    let dossier = dossiers.get(stageId);
    if (!dossier) {
      dossier = {
        instructionsArtifactId: null,
        transcriptArtifactId: null,
        gateScore: null,
        toolCalls: 0,
      };
      dossiers.set(stageId, dossier);
    }
    return dossier;
  };

  for (const stage of stages) {
    ensure(stage.stageId);
  }

  for (const view of artifacts) {
    const manifestStageId = view.manifest?.stageId;
    if (!manifestStageId || manifestStageId.includes(":coder:")) {
      continue;
    }
    if (manifestStageId.endsWith(":instructions")) {
      const stageId = manifestStageId.slice(0, -":instructions".length);
      ensure(stageId).instructionsArtifactId = view.artifact.artifactId;
      continue;
    }
    if (manifestStageId.endsWith(":transcript")) {
      const stageId = manifestStageId.slice(0, -":transcript".length);
      const dossier = ensure(stageId);
      dossier.transcriptArtifactId = view.artifact.artifactId;
      const parsed = await readJson(store, view);
      if (parsed) {
        if (typeof parsed.gateScore === "number") {
          dossier.gateScore = parsed.gateScore;
        }
        if (typeof parsed.toolCalls === "number") {
          dossier.toolCalls = parsed.toolCalls;
        }
      }
    }
  }

  return Object.fromEntries(dossiers);
}

export const loadRunSummaries = cache(async function loadRunSummaries(
  limit = 20,
  store?: Store,
): Promise<RunSummary[]> {
  const client = store ?? (await getStore());
  const runs = await client.runs.listRecent(limit);

  return Promise.all(
    runs.map(async (run) => {
      const artifacts = await client.artifactStore.listByRun(run.runId);
      const manifests = await Promise.all(
        artifacts.map((artifact) => client.manifests.get(artifact.manifestId)),
      );
      let costCny = 0;
      let tokens = 0;
      for (const manifest of manifests) {
        if (!manifest) {
          continue;
        }
        costCny += manifest.cost.amount;
        tokens += manifest.cost.tokens;
      }

      return {
        run,
        costCny,
        tokens,
        artifactCount: artifacts.length,
      };
    }),
  );
});

export async function loadArtifactContent(
  artifact: ArtifactVersion,
  store?: Store,
  maxChars = 24_000,
): Promise<{ text: string; truncated: boolean; unavailable: boolean }> {
  const client = store ?? (await getStore());
  const blob = await client.blobs.findById(artifact.blobId);
  if (!blob) {
    return { text: "", truncated: false, unavailable: true };
  }

  let bytes: Uint8Array;
  try {
    bytes = await client.blobClient.get(blob.storageKey);
  } catch {
    return { text: "", truncated: false, unavailable: true };
  }

  const text = new TextDecoder().decode(bytes);
  if (text.length <= maxChars) {
    return { text, truncated: false, unavailable: false };
  }
  return { text: text.slice(0, maxChars), truncated: true, unavailable: false };
}

export async function loadBlobText(
  artifact: ArtifactView,
  store?: Store,
  maxChars = 24_000,
): Promise<{ text: string; truncated: boolean; unavailable: boolean }> {
  return loadArtifactContent(artifact.artifact, store, maxChars);
}

export async function loadApprovalForRun(
  runId: string,
  store?: Store,
): Promise<ApprovalView | null> {
  const detail = await loadRunDetail(runId, store);
  return detail?.approval ?? null;
}

export const loadPausedRuns = cache(async function loadPausedRuns(
  store?: Store,
): Promise<
  Array<{
    run: Run;
    approval: ApprovalView | null;
    costCny: number;
  }>
> {
  const client = store ?? (await getStore());
  const paused = await client.runs.list({ status: "paused", limit: 50 });
  return Promise.all(
    paused.map(async (run) => {
      const detail = await loadRunDetail(run.runId, client);
      return {
        run,
        approval: detail?.approval ?? null,
        costCny: detail?.costCny ?? 0,
      };
    }),
  );
});

export const loadPausedCount = cache(async function loadPausedCount(
  store?: Store,
): Promise<number> {
  const client = store ?? (await getStore());
  const paused = await client.runs.list({ status: "paused", limit: 100 });
  return paused.length;
});

export function orderStages(stages: Stage[]): Stage[] {
  return [...stages].sort((a, b) => {
    const aTime = a.startedAt ?? "9999-12-31T23:59:59.999Z";
    const bTime = b.startedAt ?? "9999-12-31T23:59:59.999Z";
    return aTime.localeCompare(bTime) || a.name.localeCompare(b.name);
  });
}

async function readJson(
  store: Store,
  view: ArtifactView,
): Promise<Record<string, unknown> | null> {
  const { text } = await loadBlobText(view, store, 200_000);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
