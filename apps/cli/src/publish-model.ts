import {
  type PublishedArtifact,
  type PublishedRun,
  type PublishedStage,
  extractTitleSummary,
  findSecret,
} from "@kit/publish";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

const MAX_PUBLISH_BYTES = 512 * 1024;

const INTERNAL_MARKERS = [
  ":tool:",
  ":delivery",
  ":gate:",
  ":approval-request",
  ":manager-",
  ":decision",
  ":revision-",
];

export class PublishSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishSafetyError";
  }
}

export async function buildPublishedRun(
  store: Store,
  runId: string,
): Promise<PublishedRun> {
  const run = await store.runs.get(runId);
  if (!run) {
    throw new Error(`run not found: ${runId}`);
  }

  const [stages, artifacts] = await Promise.all([
    store.stages.listByRun(runId),
    store.artifactStore.listByRun(runId),
  ]);

  let costCny = 0;
  let tokens = 0;
  const published: PublishedArtifact[] = [];

  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    if (manifest) {
      costCny += manifest.cost.amount;
      tokens += manifest.cost.tokens;
    }
    if (!manifest) {
      continue;
    }

    const stageId = manifest.stageId;
    if (INTERNAL_MARKERS.some((marker) => stageId.includes(marker))) {
      continue;
    }

    const blob = await store.blobs.findById(artifact.blobId);
    if (!blob) {
      continue;
    }
    const bytes = await store.blobClient.get(blob.storageKey);
    const truncated = bytes.byteLength > MAX_PUBLISH_BYTES;
    const slice = truncated ? bytes.slice(0, MAX_PUBLISH_BYTES) : bytes;
    const text = new TextDecoder().decode(slice);

    const secret = findSecret(text);
    if (secret) {
      throw new PublishSafetyError(
        `artifact ${artifact.artifactId} appears to contain a ${secret}; refusing to publish`,
      );
    }

    const stage = findStage(stages, run.runId, stageId);
    const stageName =
      stage?.name ?? (stageId.split(":").slice(1).join(":") || "stage");

    const trimmed = text.trim();
    let markdown = text;
    let jsonGoal: string | undefined;
    let isJson = false;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        markdown = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
        isJson = true;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "goal" in parsed &&
          typeof (parsed as { goal?: unknown }).goal === "string"
        ) {
          jsonGoal = (parsed as { goal: string }).goal;
        }
      } catch {
        // Keep the original text if it is not valid JSON.
      }
    }

    const { title, summary } = extractTitleSummary(markdown);
    const kind =
      stageId.endsWith(":deliver") || stageId.includes(":synthesize")
        ? "report"
        : "artifact";

    published.push({
      artifactId: artifact.artifactId,
      version: artifact.version,
      kind,
      title: title || humanizeStage(stageName),
      summary: summary || (isJson ? (jsonGoal ?? "Structured JSON plan") : ""),
      stageId,
      stageName,
      agentId: manifest.producer.agentId,
      modelId: manifest.producer.modelId,
      createdAt: artifact.createdAt,
      costCny: manifest.cost.amount,
      tokens: manifest.cost.tokens,
      markdown,
      raw: text,
      truncated,
    });
  }

  if (published.length === 0) {
    throw new Error(
      "no publishable artifacts: tool calls, gates, approvals and delivery records are excluded",
    );
  }

  published.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  const publishedStages: PublishedStage[] = stages.map((stage) => ({
    stageId: stage.stageId,
    name: stage.name,
    status: stage.status,
    ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
    ...(stage.finishedAt ? { finishedAt: stage.finishedAt } : {}),
    ...(stage.error ? { error: stage.error } : {}),
    artifactIds: published
      .filter((artifact) => {
        const prefix = `${run.runId}:${stage.name}`;
        return (
          artifact.stageId === prefix ||
          artifact.stageId.startsWith(`${prefix}:`)
        );
      })
      .map((artifact) => artifact.artifactId),
  }));

  const final =
    [...published].reverse().find((artifact) => artifact.kind === "report") ??
    published[published.length - 1];
  if (final) {
    final.kind = "report";
  }

  return {
    runId: run.runId,
    title: final?.title || `${run.workflowId} run`,
    summary: final?.summary || `${run.workflowId} · ${run.status}`,
    workflowId: run.workflowId,
    workspaceId: run.workspaceId,
    status: run.status,
    runMode: run.runMode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    costCny,
    tokens,
    durationMs: estimateDuration(stages, run.createdAt, run.updatedAt),
    stages: publishedStages,
    artifacts: published,
  };
}

function humanizeStage(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function findStage(
  stages: Array<{ name: string }>,
  runId: string,
  stageId: string,
): { name: string } | undefined {
  return stages.find((stage) => {
    const prefix = `${runId}:${stage.name}`;
    return stageId === prefix || stageId.startsWith(`${prefix}:`);
  });
}

function estimateDuration(
  stages: Array<{ startedAt?: string; finishedAt?: string }>,
  createdAt: string,
  updatedAt: string,
): number {
  const started = stages
    .map((stage) => stage.startedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const finished = stages
    .map((stage) => stage.finishedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  if (started.length > 0 && finished.length > 0) {
    return Math.max(...finished) - Math.min(...started);
  }

  const fallback = Date.parse(updatedAt) - Date.parse(createdAt);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}
