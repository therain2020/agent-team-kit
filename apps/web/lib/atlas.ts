import { listActivity } from "@kit/activity";
import type { StageStatus } from "@kit/core";
import type { AgentState, ArtifactVersionRef, RunProjection } from "@kit/store";
import {
  type CostTimeseriesPoint,
  loadCostTimeseries,
} from "./cost-timeseries";
import {
  type ArtifactView,
  type RunDetail,
  loadRunDetail,
  orderStages,
} from "./runs";
import { ensureStoreSchema, getStore } from "./store";
import {
  ensureWorldProjectionBackfill,
  loadWorldRunMetas,
  loadWorldSnapshot,
} from "./world";
import { presenceStatus } from "./world-state";

export type AtlasNodeKind = "stage" | "gate" | "approval" | "delivery";

export type AtlasNodeStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Where a region's numbers came from. `store`/`charges`/`edges` are real reads;
 * `manifest` is the lossy artifact fallback; `demo` is the labelled demo model;
 * `empty` means the read succeeded but returned nothing (render an empty
 * state, never invented data on a real run).
 */
export type AtlasCostSource = "charges" | "manifest" | "demo" | "empty";
export type AtlasEvidenceSource = "edges" | "manifest" | "demo" | "empty";

/** Agent id used when a budget charge carries no agent attribution. */
export const UNATTRIBUTED_AGENT = "unattributed";

export interface AtlasNode {
  id: string;
  kind: AtlasNodeKind;
  name: string;
  status: AtlasNodeStatus;
  /** Visual layer: left-to-right execution depth. */
  column: number;
  /** Visual row; the renderer stacks lanes top to bottom. */
  lane: number;
  agentId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  costCny: number;
  tokens: number;
  artifacts: number;
  /** `artifactId@version` keys so a stage can focus its evidence chain. */
  artifactKeys: string[];
  artifactTimes: string[];
  /** The stage the world projection reports as in flight. */
  current: boolean;
  gatePass?: boolean;
  meta?: string;
}

export interface AtlasEdge {
  id: string;
  from: string;
  to: string;
  kind: "flow" | "loop";
  active: boolean;
  value: number;
}

export interface AtlasAgent {
  id: string;
  status: AtlasNodeStatus;
  costCny: number;
  tokens: number;
  artifacts: number;
  nodeIds: string[];
}

export interface AtlasFlow {
  id: string;
  agentId: string;
  nodeId: string;
  value: number;
  tokens: number;
}

export interface AtlasCostBucket {
  at: string;
  cny: number;
  tokens: number;
}

export interface AtlasEvent {
  id: string;
  seq: number;
  at: string;
  kind: string;
  agentId?: string;
  nodeId?: string;
  label: string;
}

export interface AtlasArtifactLink {
  key: string;
  artifactId: string;
  artifactVersion: number;
  /** Stage node id when the ref belongs to this run, else null. */
  stageId: string | null;
  stageName: string | null;
  agentId: string | null;
  relation: string;
  depth: number;
}

export interface AtlasGateUse {
  stageId: string;
  stageName: string;
  pass: boolean;
}

export interface AtlasEvidenceArtifact {
  key: string;
  artifactId: string;
  version: number;
  stageId: string | null;
  stageName: string | null;
  agentId: string | null;
  createdAt: string;
  /** Upstream artifacts this version consumed (ancestry, depth 1). */
  inputs: AtlasArtifactLink[];
  /** Downstream artifacts that consumed this version (reverse edges). */
  consumers: AtlasArtifactLink[];
  /** Gates whose judge artifact consumed this version. */
  gates: AtlasGateUse[];
}

export interface AtlasEvidence {
  source: AtlasEvidenceSource;
  artifacts: AtlasEvidenceArtifact[];
  /** `artifactId@version` the drill-down is focused on. */
  focus: string | null;
}

export interface AtlasRunSummary {
  runId: string;
  workflowId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  costCny: number;
  /** 0..1 from the world projection. */
  progress: number;
  currentStage: string | null;
}

export interface AtlasRun {
  runId: string;
  workflowId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  /** Snapshot time: SSR and hydration share it, and running bars end here. */
  now: string;
  /** #138 world cursor the snapshot was taken at (T alignment). */
  cursor: { seq: number; asOf: string };
  /** 0..1; world projection progress, else stages done / total. */
  progress: number;
  /** Human wait reason from the projection when the run is paused. */
  waitReason: string | null;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  agents: AtlasAgent[];
  flows: AtlasFlow[];
  costBuckets: AtlasCostBucket[];
  costSource: AtlasCostSource;
  evidence: AtlasEvidence;
  events: AtlasEvent[];
  totals: {
    costCny: number;
    tokens: number;
    artifacts: number;
    durationMs: number;
    done: number;
    total: number;
    gatePassed: number;
    gateTotal: number;
  };
  demo: boolean;
  source: "store" | "demo";
  runs: AtlasRunSummary[];
}

export interface AtlasLoadOptions {
  runId?: string;
  /** `artifactId@version` to focus the evidence drill-down. */
  artifactKey?: string;
}

const EVIDENCE_CONSUMER_BUDGET = 16;
const EVIDENCE_CONCURRENCY = 6;

/**
 * Atlas view model. One page read composes existing read models instead of
 * introducing a new projection: the #138 world snapshot supplies the run list,
 * cursor and per-run status/cost; `loadRunDetail` supplies stages, artifacts
 * and gates; the #144 cost time series supplies the river; and #140
 * `consumersOf` supplies reverse lineage for the evidence chain. Missing
 * pieces degrade visibly (demo model or explicit empty state), never silently.
 */
export async function loadAtlasRun(
  options: AtlasLoadOptions = {},
): Promise<AtlasRun> {
  try {
    await ensureWorldProjectionBackfill();
    await ensureStoreSchema();
    const store = getStore();

    const [world, metas, recentRuns] = await Promise.all([
      loadWorldSnapshot(store, { limit: 60 }),
      loadWorldRunMetas(store),
      store.runs.listRecent(24),
    ]);

    const projections = new Map<string, RunProjection>(
      world.snapshot.runs.map((run) => [run.runId, run]),
    );
    const metaByRun = new Map(metas.map((meta) => [meta.runId, meta]));
    const runs: AtlasRunSummary[] = recentRuns.map((run) => {
      const projection = projections.get(run.runId);
      return {
        runId: run.runId,
        workflowId: run.workflowId,
        status: projection?.status ?? run.status,
        createdAt: run.createdAt,
        startedAt: metaByRun.get(run.runId)?.startedAt ?? run.createdAt,
        costCny: projection?.costCny ?? 0,
        progress: projection?.progress ?? 0,
        currentStage: projection?.currentStage ?? null,
      };
    });

    const targetId = options.runId ?? runs[0]?.runId;
    if (!targetId) {
      return demoAtlas(runs, emptyEvidence("empty"));
    }

    const detail = await loadRunDetail(targetId, store);
    if (!detail) {
      return demoAtlas(runs, emptyEvidence("empty"));
    }

    const [costRows, activity] = await Promise.all([
      loadCostTimeseries({ runId: targetId, bucketMinutes: 15 }).catch(
        () => [] as CostTimeseriesPoint[],
      ),
      listActivity(store, { runId: targetId, limit: 400 }).catch(() => []),
    ]);

    const evidence = await loadEvidence(detail, store, options.artifactKey);

    return buildAtlas({
      detail,
      projection: projections.get(targetId) ?? null,
      agents: world.snapshot.agents,
      cursor: { seq: world.seq, asOf: world.snapshot.computedAt },
      costRows,
      activity,
      evidence,
      runs,
    });
  } catch (error) {
    console.error(
      `[atlas] falling back to demo: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return demoAtlas([], emptyEvidence("empty"));
  }
}

type Store = ReturnType<typeof getStore>;

function buildAtlas(input: {
  detail: RunDetail;
  projection: RunProjection | null;
  agents: AgentState[];
  cursor: { seq: number; asOf: string };
  costRows: CostTimeseriesPoint[];
  activity: Awaited<ReturnType<typeof listActivity>>;
  evidence: AtlasEvidence;
  runs: AtlasRunSummary[];
}): AtlasRun {
  const { detail, projection, cursor } = input;
  const runId = detail.run.runId;
  const runStatus = projection?.status ?? detail.run.status;
  const nowMs = Number.isFinite(Date.parse(cursor.asOf))
    ? Date.parse(cursor.asOf)
    : Date.now();

  const stages = orderStages(detail.stages);
  const stageIndex = new Map(
    stages.map((stage, index) => [stage.stageId, index]),
  );
  const views = latestArtifacts(detail.artifacts);

  const nodeKey = (raw: string | null | undefined): string | null => {
    if (!raw) {
      return null;
    }
    if (stageIndex.has(raw)) {
      return raw;
    }
    let best: string | null = null;
    for (const stage of stages) {
      const full = `${runId}:${stage.name}`;
      const matches =
        raw === full ||
        raw.startsWith(`${stage.stageId}:`) ||
        raw.startsWith(`${full}:`);
      if (matches && (best === null || stage.stageId.length > best.length)) {
        best = stage.stageId;
      }
    }
    if (best === null) {
      const short = raw.startsWith(`${runId}:`)
        ? raw.slice(runId.length + 1)
        : raw;
      const match = stages.find(
        (stage) => stage.name === short || short.startsWith(`${stage.name}:`),
      );
      best = match?.stageId ?? null;
    }
    return best;
  };

  // Artifacts grouped by stage node.
  const viewsByNode = new Map<string, ArtifactView[]>();
  const viewByArtifact = new Map<string, ArtifactView>();
  for (const view of views) {
    if (!viewByArtifact.has(view.artifact.artifactId)) {
      viewByArtifact.set(view.artifact.artifactId, view);
    }
    const nodeId = nodeKey(view.manifest?.stageId);
    if (!nodeId) {
      continue;
    }
    const bucket = viewsByNode.get(nodeId) ?? [];
    bucket.push(view);
    viewsByNode.set(nodeId, bucket);
  }

  // #144 cost time series → per-node totals and agent→stage flows.
  let chargeCny = 0;
  let chargeTokens = 0;
  const chargeByNode = new Map<string, { cny: number; tokens: number }>();
  const nodeAgents = new Map<string, Map<string, number>>();
  const flowMap = new Map<string, AtlasFlow>();
  const bucketTotals = new Map<string, AtlasCostBucket>();
  for (const row of input.costRows) {
    if (row.cny <= 0 && row.tokens <= 0) {
      continue;
    }
    chargeCny += row.cny;
    chargeTokens += row.tokens;
    const bucketKey = row.bucket;
    const bucket = bucketTotals.get(bucketKey) ?? {
      at: bucketKey,
      cny: 0,
      tokens: 0,
    };
    bucket.cny += row.cny;
    bucket.tokens += row.tokens;
    bucketTotals.set(bucketKey, bucket);

    const nodeId = nodeKey(row.stageId);
    if (!nodeId) {
      continue;
    }
    const nodeTotals = chargeByNode.get(nodeId) ?? { cny: 0, tokens: 0 };
    nodeTotals.cny += row.cny;
    nodeTotals.tokens += row.tokens;
    chargeByNode.set(nodeId, nodeTotals);

    const agentId = row.agentId ?? UNATTRIBUTED_AGENT;
    const agentSpend = nodeAgents.get(nodeId) ?? new Map<string, number>();
    agentSpend.set(agentId, (agentSpend.get(agentId) ?? 0) + row.cny);
    nodeAgents.set(nodeId, agentSpend);

    const flowId = `${agentId}→${nodeId}`;
    const flow = flowMap.get(flowId) ?? {
      id: flowId,
      agentId,
      nodeId,
      value: 0,
      tokens: 0,
    };
    flow.value += row.cny;
    flow.tokens += row.tokens;
    flowMap.set(flowId, flow);
  }
  const hasCharges = chargeCny > 0 || chargeTokens > 0;

  let manifestCny = 0;
  let manifestTokens = 0;
  for (const view of views) {
    if (!view.manifest) {
      continue;
    }
    manifestCny += view.manifest.cost.amount;
    manifestTokens += view.manifest.cost.tokens;
  }

  // Legacy stores may have no budget charges at all (#144 predates many
  // runs). Fall back to manifest-declared cost so the river still shows the
  // real agent→stage split, and label the source as manifests.
  if (!hasCharges) {
    for (const view of views) {
      const manifest = view.manifest;
      if (!manifest) {
        continue;
      }
      const nodeId = nodeKey(manifest.stageId);
      if (!nodeId) {
        continue;
      }
      const agentId = manifest.producer.agentId;
      const flowId = `${agentId}→${nodeId}`;
      const flow = flowMap.get(flowId) ?? {
        id: flowId,
        agentId,
        nodeId,
        value: 0,
        tokens: 0,
      };
      flow.value += manifest.cost.amount;
      flow.tokens += manifest.cost.tokens;
      flowMap.set(flowId, flow);

      const bucketKey = fifteenMinuteBucket(view.artifact.createdAt);
      const bucket = bucketTotals.get(bucketKey) ?? {
        at: bucketKey,
        cny: 0,
        tokens: 0,
      };
      bucket.cny += manifest.cost.amount;
      bucket.tokens += manifest.cost.tokens;
      bucketTotals.set(bucketKey, bucket);
    }
  }

  const currentStage = nodeKey(projection?.currentStage);

  const nodes: AtlasNode[] = stages.map((stage, index) => {
    const nodeViews = viewsByNode.get(stage.stageId) ?? [];
    const charge = chargeByNode.get(stage.stageId);
    const producers = new Set<string>();
    let stageManifestCny = 0;
    let stageManifestTokens = 0;
    const artifactTimes: string[] = [];
    const artifactKeys: string[] = [];
    for (const view of nodeViews) {
      artifactTimes.push(view.artifact.createdAt);
      artifactKeys.push(keyOf(view));
      if (!view.manifest) {
        continue;
      }
      producers.add(view.manifest.producer.agentId);
      stageManifestCny += view.manifest.cost.amount;
      stageManifestTokens += view.manifest.cost.tokens;
    }

    const spenders = nodeAgents.get(stage.stageId);
    const agentId =
      (spenders
        ? [...spenders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        : undefined) ?? [...producers].sort()[0];

    const gate = detail.gates
      .filter(
        (entry) =>
          entry.stageId === stage.stageId ||
          entry.stageId.startsWith(`${stage.stageId}:`),
      )
      .pop();

    const started = parseTime(stage.startedAt);
    const finished = parseTime(stage.finishedAt);
    const durationMs =
      started === null
        ? undefined
        : Math.max(
            0,
            (finished ?? (stage.status === "running" ? nowMs : started)) -
              started,
          );

    const current = currentStage === stage.stageId;
    return {
      id: stage.stageId,
      kind: detectKind(stage.name),
      name: stage.name,
      status: mapStageStatus(stage.status, runStatus, current),
      column: index,
      lane: 0,
      ...(agentId ? { agentId } : {}),
      ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
      ...(stage.finishedAt ? { endedAt: stage.finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      costCny: hasCharges ? (charge?.cny ?? 0) : stageManifestCny,
      tokens: hasCharges ? (charge?.tokens ?? 0) : stageManifestTokens,
      artifacts: nodeViews.length,
      artifactKeys,
      artifactTimes,
      current,
      ...(gate ? { gatePass: gate.pass } : {}),
      ...(stage.error ? { meta: stage.error.slice(0, 80) } : {}),
    } satisfies AtlasNode;
  });

  assignLanes(nodes, nowMs);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeMap = new Map<string, AtlasEdge>();
  const addEdge = (from: string, to: string, kind: "flow" | "loop") => {
    if (from === to) {
      return;
    }
    const id = `${from}→${to}`;
    if (edgeMap.has(id)) {
      return;
    }
    const target = byId.get(to);
    edgeMap.set(id, {
      id,
      from,
      to,
      kind,
      active: target?.status === "running" || target?.status === "waiting",
      value: target?.costCny ?? 0,
    });
  };

  // Topology from artifact lineage: who consumed whose stage output.
  for (const stage of stages) {
    for (const view of viewsByNode.get(stage.stageId) ?? []) {
      for (const input of view.manifest?.inputs ?? []) {
        const producer = viewByArtifact.get(input.artifactId);
        const fromNode = nodeKey(producer?.manifest?.stageId);
        if (!fromNode || fromNode === stage.stageId) {
          continue;
        }
        const fromIndex = stageIndex.get(fromNode) ?? 0;
        const toIndex = stageIndex.get(stage.stageId) ?? 0;
        addEdge(
          fromNode,
          stage.stageId,
          fromIndex >= toIndex ? "loop" : "flow",
        );
      }
    }
  }
  if (edgeMap.size === 0) {
    // No lineage recorded yet: fall back to declared order.
    for (let index = 1; index < nodes.length; index += 1) {
      const previous = nodes[index - 1];
      const node = nodes[index];
      if (previous && node) {
        addEdge(previous.id, node.id, "flow");
      }
    }
  }

  const agentByState = new Map(
    input.agents.map((agent) => [agent.agentId, presenceStatus(agent.state)]),
  );
  const agentBuckets = new Map<string, AtlasAgent>();
  const ensureAgent = (id: string): AtlasAgent => {
    const existing = agentBuckets.get(id);
    if (existing) {
      return existing;
    }
    const state = agentByState.get(id);
    const created: AtlasAgent = {
      id,
      status: state ? mapPresence(state) : "pending",
      costCny: 0,
      tokens: 0,
      artifacts: 0,
      nodeIds: [],
    };
    agentBuckets.set(id, created);
    return created;
  };
  for (const flow of flowMap.values()) {
    const agent = ensureAgent(flow.agentId);
    agent.costCny += flow.value;
    agent.tokens += flow.tokens;
    if (!agent.nodeIds.includes(flow.nodeId)) {
      agent.nodeIds.push(flow.nodeId);
    }
  }
  for (const node of nodes) {
    if (!node.agentId) {
      continue;
    }
    const agent = ensureAgent(node.agentId);
    agent.artifacts += node.artifacts;
    if (!agent.nodeIds.includes(node.id)) {
      agent.nodeIds.push(node.id);
    }
    agent.status = mergeStatus(agent.status, node.status);
  }

  const events: AtlasEvent[] = input.activity
    .slice(-160)
    .map((event) => {
      const nodeId = nodeKey(event.stageId);
      return {
        id: String(event.eventId),
        seq: event.eventId,
        at: event.createdAt,
        kind: event.kind,
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(nodeId ? { nodeId } : {}),
        label:
          event.summary?.slice(0, 160) ??
          [event.kind, event.tool, event.status].filter(Boolean).join(" · "),
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  const startedAt = nodes
    .map((node) => node.startedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const endedCandidates = nodes
    .map((node) => node.endedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const endedAt = endedCandidates[endedCandidates.length - 1];
  const durationMs =
    startedAt === undefined
      ? 0
      : Math.max(
          0,
          (endedAt ? Date.parse(endedAt) : nowMs) - Date.parse(startedAt),
        );

  const gateNodes = nodes.filter((node) => node.gatePass !== undefined);
  const done = nodes.filter((node) => node.status === "succeeded").length;
  const progress =
    projection?.progress ?? (nodes.length > 0 ? done / nodes.length : 0);

  return {
    runId,
    workflowId: detail.run.workflowId,
    status: runStatus,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    now: cursor.asOf,
    cursor,
    progress,
    waitReason: projection?.waitReason ?? null,
    nodes,
    edges: [...edgeMap.values()],
    agents: [...agentBuckets.values()].sort(
      (a, b) => b.costCny - a.costCny || a.id.localeCompare(b.id),
    ),
    flows: [...flowMap.values()].filter(
      (flow) => byId.has(flow.nodeId) && flow.value > 0,
    ),
    costBuckets: [...bucketTotals.values()].sort((a, b) =>
      a.at.localeCompare(b.at),
    ),
    costSource: hasCharges
      ? "charges"
      : manifestCny > 0 || manifestTokens > 0
        ? "manifest"
        : "empty",
    evidence: input.evidence,
    events,
    totals: {
      costCny: hasCharges ? chargeCny : manifestCny,
      tokens: hasCharges ? chargeTokens : manifestTokens,
      artifacts: projection?.artifactCount ?? views.length,
      durationMs,
      done,
      total: nodes.length,
      gatePassed: gateNodes.filter((node) => node.gatePass).length,
      gateTotal: gateNodes.length,
    },
    demo: false,
    source: "store",
    runs: input.runs,
  };
}

/* ------------------------------------------------------------------ */
/* Evidence chain (#140)                                               */
/* ------------------------------------------------------------------ */

async function loadEvidence(
  detail: RunDetail,
  store: Store,
  focusKey: string | undefined,
): Promise<AtlasEvidence> {
  const views = latestArtifacts(detail.artifacts);
  if (views.length === 0) {
    return emptyEvidence("empty");
  }
  const runId = detail.run.runId;
  const linkByKey = new Map<string, AtlasArtifactLink>();
  for (const view of views) {
    linkByKey.set(keyOf(view), {
      key: keyOf(view),
      artifactId: view.artifact.artifactId,
      artifactVersion: view.artifact.version,
      stageId: nodeIdOf(view.manifest?.stageId, runId),
      stageName: shortStageName(view.manifest?.stageId, runId),
      agentId: view.manifest?.producer.agentId ?? null,
      relation: "artifact",
      depth: 0,
    });
  }

  const gateByStage = new Map(detail.gates.map((gate) => [gate.stageId, gate]));
  const gatesByInput = new Map<string, AtlasGateUse[]>();
  for (const view of views) {
    const manifest = view.manifest;
    if (!manifest || !manifest.stageId.includes(":gate")) {
      continue;
    }
    const gate = gateByStage.get(manifest.stageId);
    for (const input of manifest.inputs) {
      const inputKey = `${input.artifactId}@${input.version}`;
      const list = gatesByInput.get(inputKey) ?? [];
      list.push({
        stageId: manifest.stageId,
        stageName: shortStageName(manifest.stageId, runId) ?? manifest.stageId,
        pass: gate?.pass ?? false,
      });
      gatesByInput.set(inputKey, list);
    }
  }

  const consumersByKey = new Map<string, AtlasArtifactLink[]>();
  const bounded = views.slice(0, EVIDENCE_CONSUMER_BUDGET);
  await mapLimit(bounded, EVIDENCE_CONCURRENCY, async (view) => {
    const refs = await store.artifactStore
      .consumersOf(view.artifact.artifactId, view.artifact.version)
      .catch(() => [] as ArtifactVersionRef[]);
    consumersByKey.set(
      keyOf(view),
      refs.map((ref) => linkOfRef(ref, linkByKey, runId)),
    );
  });

  const artifacts: AtlasEvidenceArtifact[] = views.map((view) => {
    const key = keyOf(view);
    const manifest = view.manifest;
    return {
      key,
      artifactId: view.artifact.artifactId,
      version: view.artifact.version,
      stageId: nodeIdOf(manifest?.stageId, runId),
      stageName: shortStageName(manifest?.stageId, runId),
      agentId: manifest?.producer.agentId ?? null,
      createdAt: view.artifact.createdAt,
      inputs: (manifest?.inputs ?? []).map((ref) =>
        linkOfRef(ref, linkByKey, runId),
      ),
      consumers: consumersByKey.get(key) ?? [],
      gates: gatesByInput.get(key) ?? [],
    };
  });

  const hasConsumers = artifacts.some(
    (artifact) => artifact.consumers.length > 0,
  );
  const focus =
    focusKey && artifacts.some((artifact) => artifact.key === focusKey)
      ? focusKey
      : (artifacts[0]?.key ?? null);

  return {
    source: hasConsumers ? "edges" : "manifest",
    artifacts,
    focus,
  };
}

function linkOfRef(
  ref: ArtifactVersionRef,
  linkByKey: Map<string, AtlasArtifactLink>,
  runId: string,
): AtlasArtifactLink {
  const key = `${ref.artifactId}@${ref.version}`;
  const known = linkByKey.get(key);
  if (known) {
    return { ...known, relation: "artifact", depth: 1 };
  }
  return {
    key,
    artifactId: ref.artifactId,
    artifactVersion: ref.version,
    stageId: nodeIdOf(ref.artifactId, runId),
    stageName: ref.artifactId.startsWith(`${runId}:`)
      ? shortStageName(ref.artifactId, runId)
      : null,
    agentId: null,
    relation: "artifact",
    depth: 1,
  };
}

/** Latest version per artifact id, newest first. */
function latestArtifacts(views: ArtifactView[]): ArtifactView[] {
  const byId = new Map<string, ArtifactView>();
  for (const view of views) {
    const current = byId.get(view.artifact.artifactId);
    if (!current || view.artifact.version > current.artifact.version) {
      byId.set(view.artifact.artifactId, view);
    }
  }
  return [...byId.values()].sort((a, b) =>
    b.artifact.createdAt.localeCompare(a.artifact.createdAt),
  );
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) {
          await run(item);
        }
      }
    },
  );
  await Promise.all(workers);
}

function keyOf(view: ArtifactView): string {
  return `${view.artifact.artifactId}@${view.artifact.version}`;
}

function nodeIdOf(
  stageId: string | null | undefined,
  runId: string,
): string | null {
  if (!stageId) {
    return null;
  }
  return stageId.startsWith(`${runId}:`) || stageId === runId ? stageId : null;
}

function shortStageName(
  stageId: string | null | undefined,
  runId: string,
): string | null {
  if (!stageId) {
    return null;
  }
  const short = stageId.startsWith(`${runId}:`)
    ? stageId.slice(runId.length + 1)
    : stageId;
  return short.split(":").slice(0, 2).join(":");
}

function emptyEvidence(source: AtlasEvidenceSource): AtlasEvidence {
  return { source, artifacts: [], focus: null };
}

/* ------------------------------------------------------------------ */
/* Status / layout helpers                                             */
/* ------------------------------------------------------------------ */

function detectKind(name: string): AtlasNodeKind {
  const value = name.toLowerCase();
  if (value.includes("approv")) {
    return "approval";
  }
  if (value.includes("gate") || value.includes("review")) {
    return "gate";
  }
  if (value.includes("deliver") || value.includes("publish")) {
    return "delivery";
  }
  return "stage";
}

function mapStageStatus(
  status: StageStatus,
  runStatus: string,
  current: boolean,
): AtlasNodeStatus {
  if (status === "running") {
    return runStatus === "paused" ? "waiting" : "running";
  }
  if (status === "pending" && current && runStatus === "paused") {
    return "waiting";
  }
  if (status === "pending") {
    return "pending";
  }
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  return "skipped";
}

function mapPresence(
  status: ReturnType<typeof presenceStatus>,
): AtlasNodeStatus {
  switch (status) {
    case "working":
      return "running";
    case "waiting-approval":
    case "blocked":
      return "waiting";
    case "error":
      return "failed";
    default:
      return "succeeded";
  }
}

const STATUS_WEIGHT: Record<AtlasNodeStatus, number> = {
  failed: 5,
  running: 4,
  waiting: 3,
  pending: 2,
  skipped: 1,
  succeeded: 0,
};

function mergeStatus(
  left: AtlasNodeStatus,
  right: AtlasNodeStatus,
): AtlasNodeStatus {
  return STATUS_WEIGHT[right] > STATUS_WEIGHT[left] ? right : left;
}

/**
 * Lanes are time lanes: two stages share a lane only when their execution
 * windows do not overlap, so concurrency reads as vertical stacking.
 */
function assignLanes(nodes: AtlasNode[], nowMs: number): void {
  const laneEnds: number[] = [];
  for (const node of nodes) {
    const start = parseTime(node.startedAt);
    if (start === null) {
      node.lane = 0;
      continue;
    }
    const end =
      parseTime(node.endedAt) ??
      (node.status === "running" || node.status === "waiting"
        ? Math.max(start + 1, nowMs)
        : start + 1);
    let lane = laneEnds.findIndex((value) => value <= start);
    if (lane === -1) {
      lane = laneEnds.length;
    }
    laneEnds[lane] = end;
    node.lane = lane;
  }
}

function fifteenMinuteBucket(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return iso;
  }
  const step = 15 * 60_000;
  return new Date(Math.floor(at / step) * step).toISOString();
}

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ */
/* Demo model                                                          */
/* ------------------------------------------------------------------ */

function demoAtlas(runs: AtlasRunSummary[], evidence: AtlasEvidence): AtlasRun {
  const now = Date.now();
  const at = (minutesAgo: number) =>
    new Date(now - minutesAgo * 60_000).toISOString();

  const defs: Array<{
    id: string;
    kind: AtlasNodeKind;
    name: string;
    status: AtlasNodeStatus;
    column: number;
    lane: number;
    agentId: string;
    start: number | null;
    end: number | null;
    costCny: number;
    tokens: number;
    artifacts: number;
    current?: boolean;
    gatePass?: boolean;
    meta?: string;
  }> = [
    {
      id: "intake",
      kind: "stage",
      name: "intake",
      status: "succeeded",
      column: 0,
      lane: 0,
      agentId: "seller",
      start: 188,
      end: 185,
      costCny: 0.18,
      tokens: 1200,
      artifacts: 1,
    },
    {
      id: "research",
      kind: "stage",
      name: "research",
      status: "succeeded",
      column: 1,
      lane: 0,
      agentId: "researcher",
      start: 185,
      end: 158,
      costCny: 2.64,
      tokens: 18400,
      artifacts: 3,
    },
    {
      id: "outline",
      kind: "stage",
      name: "outline",
      status: "succeeded",
      column: 2,
      lane: 0,
      agentId: "writer",
      start: 158,
      end: 149,
      costCny: 0.42,
      tokens: 4800,
      artifacts: 2,
    },
    {
      id: "risk",
      kind: "stage",
      name: "risk-scan",
      status: "succeeded",
      column: 2,
      lane: 1,
      agentId: "researcher",
      start: 157,
      end: 141,
      costCny: 1.28,
      tokens: 9200,
      artifacts: 2,
    },
    {
      id: "draft",
      kind: "stage",
      name: "draft",
      status: "succeeded",
      column: 3,
      lane: 0,
      agentId: "writer",
      start: 149,
      end: 104,
      costCny: 5.86,
      tokens: 41200,
      artifacts: 4,
    },
    {
      id: "compliance",
      kind: "stage",
      name: "compliance",
      status: "succeeded",
      column: 3,
      lane: 1,
      agentId: "compliance",
      start: 141,
      end: 118,
      costCny: 0.93,
      tokens: 6400,
      artifacts: 2,
    },
    {
      id: "gate",
      kind: "gate",
      name: "brand-gate",
      status: "failed",
      column: 4,
      lane: 0,
      agentId: "qa",
      start: 104,
      end: 96,
      costCny: 0.36,
      tokens: 2800,
      artifacts: 2,
      gatePass: false,
      meta: "attempt 2",
    },
    {
      id: "revise",
      kind: "stage",
      name: "revise",
      status: "running",
      column: 5,
      lane: 0,
      agentId: "writer",
      start: 96,
      end: null,
      costCny: 1.47,
      tokens: 11800,
      artifacts: 1,
      current: true,
    },
    {
      id: "approve",
      kind: "approval",
      name: "approve",
      status: "waiting",
      column: 6,
      lane: 0,
      agentId: "manager",
      start: null,
      end: null,
      costCny: 0,
      tokens: 0,
      artifacts: 0,
    },
    {
      id: "deliver",
      kind: "delivery",
      name: "deliver",
      status: "pending",
      column: 7,
      lane: 0,
      agentId: "delivery",
      start: null,
      end: null,
      costCny: 0,
      tokens: 0,
      artifacts: 0,
    },
  ];

  const nodes: AtlasNode[] = defs.map((def) => {
    const piece =
      def.artifacts > 0
        ? Math.max(1, Math.floor((def.start ?? 60) - (def.end ?? 2)))
        : 0;
    const count = Math.min(def.artifacts, 5);
    const starts = def.start ?? 0;
    return {
      id: def.id,
      kind: def.kind,
      name: def.name,
      status: def.status,
      column: def.column,
      lane: def.lane,
      agentId: def.agentId,
      ...(def.start !== null ? { startedAt: at(def.start) } : {}),
      ...(def.end !== null ? { endedAt: at(def.end) } : {}),
      ...(def.start !== null
        ? { durationMs: Math.max(0, ((def.end ?? 0) - def.start) * -60_000) }
        : {}),
      costCny: def.costCny,
      tokens: def.tokens,
      artifacts: def.artifacts,
      artifactKeys: Array.from(
        { length: count },
        (_, index) => `${def.id}:demo@${index + 1}`,
      ),
      artifactTimes: Array.from({ length: count }, (_, index) =>
        at(starts - (piece * (index + 1)) / (count + 1) || 1),
      ),
      current: def.current ?? false,
      ...(def.gatePass !== undefined ? { gatePass: def.gatePass } : {}),
      ...(def.meta ? { meta: def.meta } : {}),
    };
  });

  const edge = (
    from: string,
    to: string,
    active: boolean,
    kind: "flow" | "loop" = "flow",
  ): AtlasEdge => ({
    id: `${from}→${to}`,
    from,
    to,
    kind,
    active,
    value: nodes.find((node) => node.id === to)?.costCny ?? 0,
  });

  const edges: AtlasEdge[] = [
    edge("intake", "research", false),
    edge("research", "outline", false),
    edge("research", "risk", false),
    edge("outline", "draft", false),
    edge("risk", "compliance", false),
    edge("draft", "gate", false),
    edge("compliance", "gate", false),
    edge("gate", "revise", true),
    edge("revise", "draft", true, "loop"),
    edge("revise", "approve", false),
    edge("approve", "deliver", false),
  ];

  const agentStatus: Record<string, AtlasNodeStatus> = {
    seller: "succeeded",
    researcher: "succeeded",
    writer: "running",
    qa: "failed",
    compliance: "succeeded",
    manager: "waiting",
    delivery: "pending",
  };

  const agents: AtlasAgent[] = Object.entries(agentStatus).map(
    ([id, status]) => {
      const owned = nodes.filter((node) => node.agentId === id);
      return {
        id,
        status,
        costCny: owned.reduce((sum, node) => sum + node.costCny, 0),
        tokens: owned.reduce((sum, node) => sum + node.tokens, 0),
        artifacts: owned.reduce((sum, node) => sum + node.artifacts, 0),
        nodeIds: owned.map((node) => node.id),
      };
    },
  );

  const flows: AtlasFlow[] = nodes
    .filter((node) => node.agentId && node.costCny > 0)
    .map((node) => ({
      id: `${node.agentId}→${node.id}`,
      agentId: node.agentId as string,
      nodeId: node.id,
      value: node.costCny,
      tokens: node.tokens,
    }));

  const demoCostBuckets: AtlasCostBucket[] = Array.from(
    { length: 14 },
    (_, index) => {
      const atMinutes = 188 - index * 13;
      const cny = [
        0.1, 0.4, 0.9, 1.8, 2.2, 1.1, 0.6, 1.4, 2.9, 1.7, 0.8, 1.2, 0.5, 0.3,
      ][index % 14] as number;
      return { at: at(atMinutes), cny, tokens: Math.round(cny * 7200) };
    },
  );

  const events: AtlasEvent[] = [];
  const push = (
    minutesAgo: number,
    kind: string,
    label: string,
    agentId?: string,
    nodeId?: string,
  ) =>
    events.push({
      id: `demo-${events.length}`,
      seq: events.length,
      at: at(minutesAgo),
      kind,
      ...(agentId ? { agentId } : {}),
      ...(nodeId ? { nodeId } : {}),
      label,
    });

  push(188, "run.started", "run.started · content-launch", "seller", "intake");
  push(186, "tool.call", "tool.call · crm.lookup", "seller", "intake");
  push(185, "stage.succeeded", "stage.succeeded · intake", "seller", "intake");
  push(180, "model.call", "model.call · 4.8k tokens", "researcher", "research");
  push(
    168,
    "tool.call",
    "tool.call · web.search × 7",
    "researcher",
    "research",
  );
  push(
    158,
    "stage.succeeded",
    "stage.succeeded · research",
    "researcher",
    "research",
  );
  push(
    149,
    "stage.succeeded",
    "stage.succeeded · outline",
    "writer",
    "outline",
  );
  push(
    141,
    "stage.succeeded",
    "stage.succeeded · risk-scan",
    "researcher",
    "risk",
  );
  push(130, "model.call", "model.call · 12.6k tokens", "writer", "draft");
  push(
    118,
    "artifact.committed",
    "artifact.committed · compliance:v2",
    "compliance",
    "compliance",
  );
  push(104, "stage.succeeded", "stage.succeeded · draft", "writer", "draft");
  push(100, "gate.failed", "gate.failed · tone 0.62 < 0.80", "qa", "gate");
  push(
    96,
    "revision.started",
    "revision.started · attempt 3",
    "writer",
    "revise",
  );
  push(92, "tool.call", "tool.call · brand.guidelines", "writer", "revise");
  push(88, "model.call", "model.call · 6.2k tokens", "writer", "revise");
  push(
    74,
    "artifact.committed",
    "artifact.committed · draft:v5",
    "writer",
    "revise",
  );
  push(61, "budget.warning", "budget.warning · 72% used", "manager", "revise");
  push(48, "tool.call", "tool.call · readability.check", "writer", "revise");
  push(35, "model.call", "model.call · 5.1k tokens", "writer", "revise");
  push(
    22,
    "artifact.committed",
    "artifact.committed · draft:v6",
    "writer",
    "revise",
  );
  push(
    12,
    "approval.queued",
    "approval.queued · manager review",
    "manager",
    "approve",
  );
  push(4, "tool.call", "tool.call · diff.review", "writer", "revise");

  for (let minutes = 172; minutes > 6; minutes -= 11) {
    push(
      minutes,
      "model.call",
      "model.call · stream",
      "researcher",
      "research",
    );
  }

  events.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  const gateNodes = nodes.filter((node) => node.gatePass !== undefined);
  const startedAt = at(188);
  const totalCost = nodes.reduce((sum, node) => sum + node.costCny, 0);

  const resolvedEvidence =
    evidence.artifacts.length > 0 ? evidence : demoEvidence(at);

  return {
    runId: "demo-content-launch-7f3a",
    workflowId: "content-launch",
    status: "running",
    startedAt,
    now: at(0),
    cursor: { seq: 0, asOf: at(0) },
    progress: 0.6,
    waitReason: "approval pending",
    nodes,
    edges,
    agents,
    flows,
    costBuckets: demoCostBuckets,
    costSource: "demo",
    evidence: resolvedEvidence,
    events,
    totals: {
      costCny: totalCost,
      tokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
      artifacts: nodes.reduce((sum, node) => sum + node.artifacts, 0),
      durationMs: 188 * 60_000,
      done: nodes.filter((node) => node.status === "succeeded").length,
      total: nodes.length,
      gatePassed: gateNodes.filter((node) => node.gatePass).length,
      gateTotal: gateNodes.length,
    },
    demo: true,
    source: "demo",
    runs:
      runs.length > 0
        ? runs
        : [
            {
              runId: "demo-content-launch-7f3a",
              workflowId: "content-launch",
              status: "running",
              createdAt: startedAt,
              startedAt,
              costCny: totalCost,
              progress: 0.6,
              currentStage: "demo:revise",
            },
          ],
  };
}

function demoEvidence(at: (minutesAgo: number) => string): AtlasEvidence {
  const link = (
    key: string,
    stageName: string,
    relation = "artifact",
  ): AtlasArtifactLink => ({
    key,
    artifactId: stageName,
    artifactVersion: 1,
    stageId: stageName,
    stageName,
    agentId: null,
    relation,
    depth: 1,
  });
  return {
    source: "demo",
    focus: "revise:demo@1",
    artifacts: [
      {
        key: "revise:demo@1",
        artifactId: "revise:demo",
        version: 1,
        stageId: "revise",
        stageName: "revise",
        agentId: "writer",
        createdAt: at(22),
        inputs: [link("draft:demo@4", "draft")],
        consumers: [],
        gates: [{ stageId: "gate", stageName: "brand-gate", pass: false }],
      },
      {
        key: "draft:demo@4",
        artifactId: "draft:demo",
        version: 4,
        stageId: "draft",
        stageName: "draft",
        agentId: "writer",
        createdAt: at(104),
        inputs: [
          link("outline:demo@1", "outline"),
          link("risk:demo@1", "risk-scan"),
        ],
        consumers: [link("revise:demo@1", "revise", "consumer")],
        gates: [{ stageId: "gate", stageName: "brand-gate", pass: false }],
      },
    ],
  };
}
