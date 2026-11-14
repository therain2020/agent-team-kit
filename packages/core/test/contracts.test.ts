import { describe, expect, it } from "vitest";
import {
  artifactVersionSchema,
  eventEnvelopeSchema,
  manifestSchema,
  runModeSchema,
  teamPackSchema,
  workflowStageSchema,
  workshopManifestSchema,
} from "../src/index";

const at = "2026-11-14T00:00:00.000Z";

const event = {
  eventId: "evt_1",
  type: "demo.event.received",
  schemaVersion: "1.0" as const,
  occurredAt: at,
  receivedAt: at,
  workspaceId: "default",
  idempotencyKey: "src:hash",
  traceId: "trc_1",
  payloadRef: "s3://bucket/key",
};

const manifest = {
  manifestId: "man_1",
  workspaceId: "default",
  producer: {
    agentId: "echo",
    agentVersion: "1.0.0",
    promptHash: "sha256:abc",
    modelId: "deepseek-flash",
  },
  inputs: [],
  runId: "run_1",
  stageId: "stg_1",
  runMode: "DRY_RUN" as const,
  cost: { currency: "CNY" as const, amount: 0, tokens: 0 },
  sensitivity: "internal" as const,
  retentionClass: "artifact_365d",
  createdAt: at,
};

const pack = {
  apiVersion: "agentteam/v1" as const,
  kind: "TeamPack" as const,
  metadata: {
    name: "minimal",
    version: "1.0.0",
    compatibility: { kit: ">=0.1 <2.0" },
  },
  agents: [
    {
      id: "echo",
      file: "agents/echo.md",
      model: "deepseek-flash",
      tools: [],
      skills: [],
    },
  ],
  workflows: ["workflows/demo.yaml"],
  policies: [],
};

describe("event envelope", () => {
  it("parses a valid event", () => {
    expect(eventEnvelopeSchema.parse(event).workspaceId).toBe("default");
  });

  it("rejects an empty workspace", () => {
    expect(
      eventEnvelopeSchema.safeParse({ ...event, workspaceId: "" }).success,
    ).toBe(false);
  });

  it("rejects an unknown run mode", () => {
    expect(runModeSchema.safeParse("live").success).toBe(false);
  });
});

describe("artifact contracts", () => {
  it("defaults eval and approval refs", () => {
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.evalRefs).toEqual([]);
    expect(parsed.approvalRefs).toEqual([]);
  });

  it("rejects an invalid artifact status", () => {
    const artifact = {
      artifactId: "art_1",
      version: 1,
      workspaceId: "default",
      blobId: "blb_1",
      manifestId: "man_1",
      status: "published",
      supersedes: null,
      supersededBy: null,
      createdAt: at,
    };
    expect(artifactVersionSchema.safeParse(artifact).success).toBe(false);
  });
});

describe("workflow stages", () => {
  it("parses a coder stage", () => {
    const parsed = workflowStageSchema.parse({
      id: "build",
      type: "coder",
      coder: "dsh",
      goal: "fix the bug",
      acceptance: "tests pass",
      inputs: ["findings"],
      outputs: ["patch"],
      timeout: "20m",
    });
    expect(parsed.coder).toBe("dsh");
  });

  it("rejects a coder stage without coder", () => {
    const result = workflowStageSchema.safeParse({
      id: "build",
      type: "coder",
      inputs: ["findings"],
      outputs: ["patch"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an agent stage without agent", () => {
    const result = workflowStageSchema.safeParse({
      id: "write",
      type: "agent",
      inputs: ["findings"],
      outputs: ["draft"],
    });
    expect(result.success).toBe(false);
  });
});

describe("workshop manifest", () => {
  const manifest = {
    apiVersion: "agentteam/v1",
    kind: "workflow",
    id: "demo-flow",
    name: "Demo Flow",
    version: "1.0.0",
    entry: "workflows/demo.yaml",
    files: ["workflows/demo.yaml"],
  };

  it("parses a valid manifest", () => {
    const parsed = workshopManifestSchema.parse(manifest);
    expect(parsed.permissions.code).toBe(false);
  });

  it("requires entry to be listed in files", () => {
    expect(
      workshopManifestSchema.safeParse({
        ...manifest,
        entry: "workflows/other.yaml",
      }).success,
    ).toBe(false);
  });

  it("rejects path traversal in files", () => {
    expect(
      workshopManifestSchema.safeParse({
        ...manifest,
        entry: "../evil.yaml",
        files: ["../evil.yaml"],
      }).success,
    ).toBe(false);
  });
});

describe("team pack", () => {
  it("parses a minimal pack", () => {
    expect(teamPackSchema.parse(pack).agents).toHaveLength(1);
  });

  it("requires at least one workflow", () => {
    expect(teamPackSchema.safeParse({ ...pack, workflows: [] }).success).toBe(
      false,
    );
  });
});
