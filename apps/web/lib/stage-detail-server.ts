import { loadStudioData } from "./pack-studio";
import { type ArtifactView, loadArtifactContent, loadRunDetail } from "./runs";
import {
  type StageAgentView,
  type StageArtifactView,
  type StageDefinitionView,
  type StageDetailData,
  type StageGateView,
  type StagePromptView,
  type StageTranscriptView,
  parseInstructions,
  parseTranscript,
  stageNameFromId,
} from "./stage-detail";

/**
 * Loads the stage drawer payload (issue #156 ③ 环节详情).
 *
 * One read per drawer open: the run detail already carries stages, gate
 * evidence, the dossier artifact ids and the approval; the pack definition
 * supplies the "what does this stage do" copy. Prompt/transcript blobs are
 * read only for the clicked stage, so a run with many stages stays cheap.
 */
export async function loadStageDetail(
  packDir: string,
  runId: string,
  requestedStageId: string | null,
): Promise<StageDetailData> {
  const [detail, studio] = await Promise.all([
    loadRunDetail(runId),
    loadStudioData(packDir),
  ]);

  if (!detail) {
    return {
      found: false,
      runId,
      stageId: requestedStageId,
      stageName: stageNameFromId(runId, requestedStageId),
      runStatus: null,
      stageStatus: null,
      definition: null,
      agent: null,
      prompt: null,
      transcript: null,
      gates: [],
      artifacts: [],
      approval: null,
    };
  }

  const stage =
    detail.stages.find((entry) => entry.stageId === requestedStageId) ??
    detail.stages.find(
      (entry) => entry.name === stageNameFromId(runId, requestedStageId),
    ) ??
    detail.stages.find((entry) => entry.status === "running") ??
    detail.stages[detail.stages.length - 1] ??
    null;

  const stageName = stage?.name ?? stageNameFromId(runId, requestedStageId);
  const workflow = studio?.workflows.find(
    (entry) => entry.id === detail.run.workflowId,
  );
  const stageDefinition = workflow?.stages.find(
    (entry) => entry.id === stageName,
  );

  const definition: StageDefinitionView | null = stageDefinition
    ? {
        id: stageDefinition.id,
        type: stageDefinition.type,
        agent: stageDefinition.agent ?? null,
        coder: stageDefinition.coder ?? null,
        goal: stageDefinition.goal ?? null,
        acceptance: stageDefinition.acceptance ?? null,
        timeout: stageDefinition.timeout ?? null,
        gate: stageDefinition.gate ?? null,
      }
    : null;

  const agentSource = definition?.agent
    ? studio?.agents.find((entry) => entry.id === definition.agent)
    : undefined;
  const agent: StageAgentView | null = agentSource
    ? {
        id: agentSource.id,
        role: agentSource.role,
        description: agentSource.description,
      }
    : null;

  const dossier = stage ? detail.stageDossiers[stage.stageId] : undefined;
  const instructionsView = dossier?.instructionsArtifactId
    ? findArtifact(detail.artifacts, dossier.instructionsArtifactId)
    : undefined;
  const transcriptView = dossier?.transcriptArtifactId
    ? findArtifact(detail.artifacts, dossier.transcriptArtifactId)
    : undefined;

  const [prompt, transcript] = await Promise.all([
    instructionsView ? readPrompt(instructionsView) : Promise.resolve(null),
    transcriptView ? readTranscript(transcriptView) : Promise.resolve(null),
  ]);

  const stagePrefix = stage
    ? stage.stageId
    : stageName
      ? `${runId}:${stageName}`
      : null;
  const gates: StageGateView[] = stagePrefix
    ? detail.gates
        .filter((gate) => gate.stageId.startsWith(`${stagePrefix}:gate`))
        .map((gate) => ({
          attempt: gate.attempt,
          pass: gate.pass,
          scores: gate.scores,
          thresholds: gate.thresholds,
          summary: gate.summary || gate.rationale,
        }))
    : [];

  const artifacts: StageArtifactView[] = stagePrefix
    ? detail.artifacts
        .filter((view) => {
          const manifestStage = view.manifest?.stageId ?? "";
          return (
            manifestStage === stagePrefix ||
            manifestStage.startsWith(`${stagePrefix}:`)
          );
        })
        .map((view) => ({
          artifactId: view.artifact.artifactId,
          version: view.artifact.version,
          kind: view.kind,
          stageId: view.manifest?.stageId ?? "",
          createdAt: view.artifact.createdAt,
        }))
    : [];

  const approval =
    detail.approval &&
    (!stageName ||
      !detail.approval.stageId ||
      detail.approval.stageId === stage?.stageId ||
      stageNameFromId(runId, detail.approval.stageId) === stageName)
      ? {
          requestId: detail.approval.requestId,
          summary: detail.approval.summary,
        }
      : null;

  return {
    found: true,
    runId,
    stageId: stage?.stageId ?? requestedStageId,
    stageName,
    runStatus: detail.run.status,
    stageStatus: stage?.status ?? null,
    definition,
    agent,
    prompt,
    transcript,
    gates,
    artifacts,
    approval,
  };
}

function findArtifact(
  artifacts: readonly ArtifactView[],
  artifactId: string,
): ArtifactView | undefined {
  return [...artifacts]
    .reverse()
    .find((view) => view.artifact.artifactId === artifactId);
}

async function readPrompt(view: ArtifactView): Promise<StagePromptView> {
  const content = await loadArtifactContent(view.artifact, undefined, 40_000);
  if (content.unavailable) {
    return {
      artifactId: view.artifact.artifactId,
      text: "",
      truncated: false,
      available: false,
    };
  }
  return parseInstructions(content.text, view.artifact.artifactId);
}

async function readTranscript(
  view: ArtifactView,
): Promise<StageTranscriptView> {
  const content = await loadArtifactContent(view.artifact, undefined, 200_000);
  if (content.unavailable) {
    return {
      artifactId: view.artifact.artifactId,
      available: false,
      finalResponse: "",
      turns: [],
      toolCallCount: 0,
      gateScore: null,
      durationMs: null,
      truncated: false,
      inputs: [],
      outputArtifactId: null,
    };
  }
  return parseTranscript(content.text, view.artifact.artifactId);
}
