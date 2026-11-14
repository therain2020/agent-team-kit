import { readFile } from "node:fs/promises";
import path from "node:path";
import { newId, rubricSetSchema } from "@kit/core";
import type {
  PackRunInput,
  PackStageSpec,
  WorkflowDefinition,
} from "@kit/workflow";
import { parse } from "yaml";
import type { LoadedPack } from "./load-pack";

export interface BuildPackRunOptions {
  workflow?: string;
  input?: string;
  inputFile?: string;
  stub?: boolean;
  runMode?: "DRY_RUN" | "LIVE";
}

export interface BuiltPackRun {
  workflow: WorkflowDefinition;
  eventType: string;
  input: PackRunInput;
}

export async function buildPackRun(
  loaded: LoadedPack,
  options: BuildPackRunOptions = {},
): Promise<BuiltPackRun> {
  const workflow = options.workflow
    ? loaded.workflows.find((item) => item.id === options.workflow)
    : loaded.workflows[0];

  if (!workflow) {
    throw new Error(`workflow not found: ${options.workflow ?? "<first>"}`);
  }

  const runId = newId("run");
  const eventId = newId("evt");
  const now = new Date().toISOString();
  const stages: PackStageSpec[] = [];

  for (let index = 0; index < workflow.stages.length; index += 1) {
    const stage = workflow.stages[index];
    if (!stage) {
      continue;
    }

    const stageSpec: PackStageSpec = {
      stageId: `${runId}:${stage.id}`,
      stageName: stage.id,
      type: stage.type,
    };

    if (stage.type === "agent") {
      if (!stage.agent) {
        throw new Error(
          `workflow ${workflow.id}: stage ${stage.id} has no agent`,
        );
      }
      const agent = loaded.agents.get(stage.agent);
      if (!agent) {
        throw new Error(`unknown agent: ${stage.agent}`);
      }

      const text = await readFile(
        path.join(loaded.dir, agent.spec.file),
        "utf8",
      );

      stageSpec.agentId = stage.agent;
      stageSpec.modelAlias = agent.frontmatter.model;
      stageSpec.instructions = stripFrontmatter(text);
      stageSpec.tools = agent.spec.tools;
    }

    if (stage.includeInitialInput) {
      stageSpec.includeInitialInput = true;
    }

    if (stage.inputFrom) {
      stageSpec.inputFromStageId = `${runId}:${stage.inputFrom}`;
    }

    if (stage.approval) {
      stageSpec.approval = {
        mode: stage.approval.mode,
        position: stage.approval.position,
        riskClass: stage.approval.riskClass,
        ttlMs: parseDurationMs(stage.approval.ttl),
        notify: stage.approval.notify,
        autoApproveWhen: stage.approval.autoApproveWhen,
      };
    }

    if (stage.gate) {
      const [gateFileRaw, gateKey] = stage.gate.split("#");
      const gateFile = gateFileRaw ?? "";
      const gateDoc = parse(
        await readFile(path.join(loaded.dir, gateFile), "utf8"),
      );
      const parsedRubric = rubricSetSchema.safeParse(gateDoc);
      if (!parsedRubric.success) {
        throw new Error(`invalid rubric file: ${gateFile}`);
      }

      const rubric = gateKey ? parsedRubric.data.rubrics[gateKey] : undefined;
      if (!rubric) {
        throw new Error(`rubric not found: ${stage.gate}`);
      }

      stageSpec.gate = { ref: stage.gate, dimensions: rubric.dimensions };

      const previous = workflow.stages[index - 1];
      const revisionId =
        stage.revisionAgent ??
        (previous?.type === "agent" ? previous.agent : undefined);

      if (revisionId) {
        const revisionAgent = loaded.agents.get(revisionId);
        if (revisionAgent) {
          const revisionText = await readFile(
            path.join(loaded.dir, revisionAgent.spec.file),
            "utf8",
          );
          stageSpec.revision = {
            agentId: revisionId,
            modelAlias: revisionAgent.frontmatter.model,
            instructions: stripFrontmatter(revisionText),
          };
        }
      }
    }

    stages.push(stageSpec);
  }

  const initialInput = options.inputFile
    ? await readFile(path.resolve(options.inputFile), "utf8")
    : (options.input ??
      JSON.stringify({
        type: workflow.trigger.event,
        occurredAt: now,
        payload: "synthetic",
      }));

  return {
    workflow,
    eventType: workflow.trigger.event,
    input: {
      runId,
      eventId,
      workspaceId: "default",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runMode: options.runMode ?? "DRY_RUN",
      initialInput,
      stages,
      stub: options.stub ?? false,
    },
  };
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|s)?$/i);
  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "d").toLowerCase();
  const factor =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return Math.max(1000, Math.round(amount * factor));
}
