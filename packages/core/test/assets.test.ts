import { describe, expect, it } from "vitest";
import {
  assemblyLockSchema,
  boundComponentKeys,
  componentRefSchema,
  pipelineSpecSchema,
  sourceAssetSchema,
  workshopManifestSchema,
} from "../src";

const ref = {
  kind: "agent" as const,
  id: "echo",
  version: "1.0.0",
  source: {
    repo: "acme/components",
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
  },
};

const pipeline = {
  apiVersion: "agentteam/v1",
  kind: "Pipeline",
  id: "demo-pipeline",
  version: "1.0.0",
  graph: {
    nodes: [
      { id: "draft", type: "agent" },
      { id: "review", type: "human" },
    ],
    edges: [{ from: "draft", to: "review" }],
  },
};

function manifest(kind: string, entry: string) {
  return {
    apiVersion: "agentteam/v1",
    kind,
    id: "demo-item",
    name: "Demo Item",
    version: "1.0.0",
    entry,
    files: [entry],
  };
}

describe("component contract", () => {
  it("parses a pinned component reference", () => {
    const parsed = componentRefSchema.parse(ref);
    expect(parsed.source.commit).toHaveLength(40);
    expect(parsed.source.sha256).toHaveLength(64);
  });

  it("rejects an unpinned commit or hash", () => {
    expect(
      componentRefSchema.safeParse({
        ...ref,
        source: { repo: "acme/components", commit: "main", sha256: "nope" },
      }).success,
    ).toBe(false);
  });

  it("rejects a repo that is not owner/name", () => {
    expect(
      componentRefSchema.safeParse({
        ...ref,
        source: { ...ref.source, repo: "nope" },
      }).success,
    ).toBe(false);
  });

  it("accepts two-part legacy versions", () => {
    expect(
      componentRefSchema.safeParse({ ...ref, version: "1.0" }).success,
    ).toBe(true);
  });
});

describe("pipeline spec", () => {
  it("parses a graph and defaults bindings/policies", () => {
    const parsed = pipelineSpecSchema.parse(pipeline);
    expect(parsed.bindings).toEqual([]);
    expect(parsed.policies).toEqual([]);
  });

  it("rejects an edge to an unknown node", () => {
    expect(
      pipelineSpecSchema.safeParse({
        ...pipeline,
        graph: {
          nodes: [{ id: "draft", type: "agent" }],
          edges: [{ from: "draft", to: "ghost" }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a cyclic graph", () => {
    const parsed = pipelineSpecSchema.safeParse({
      ...pipeline,
      graph: {
        nodes: [
          { id: "a", type: "agent" },
          { id: "b", type: "agent" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    expect(
      pipelineSpecSchema.safeParse({
        ...pipeline,
        graph: {
          nodes: [
            { id: "a", type: "agent" },
            { id: "a", type: "human" },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires subflow nodes to bind a workflow component", () => {
    expect(
      pipelineSpecSchema.safeParse({
        ...pipeline,
        graph: {
          nodes: [{ id: "sub", type: "subflow", component: ref }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a binding to an unknown node", () => {
    expect(
      pipelineSpecSchema.safeParse({
        ...pipeline,
        bindings: [{ node: "ghost", component: ref }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate bindings", () => {
    expect(
      pipelineSpecSchema.safeParse({
        ...pipeline,
        bindings: [
          { node: "draft", component: ref },
          { node: "draft", component: ref },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("assembly lockfile", () => {
  it("records bound components", () => {
    const lock = assemblyLockSchema.parse({
      components: [ref],
      bindings: [{ node: "draft", component: ref }],
    });
    expect(lock.lockVersion).toBe(1);
    expect(boundComponentKeys(lock)).toEqual(["agent/echo"]);
  });

  it("rejects duplicate components", () => {
    expect(
      assemblyLockSchema.safeParse({ components: [ref, ref] }).success,
    ).toBe(false);
  });

  it("rejects binding a component that is not locked", () => {
    expect(
      assemblyLockSchema.safeParse({
        components: [],
        bindings: [{ node: "draft", component: ref }],
      }).success,
    ).toBe(false);
  });
});

describe("workshop manifest asset kinds", () => {
  it("parses pipeline, source and template with their entry conventions", () => {
    expect(
      workshopManifestSchema.parse(manifest("pipeline", "pipeline.yaml")).kind,
    ).toBe("pipeline");
    expect(
      workshopManifestSchema.parse(manifest("source", "source.yaml")).kind,
    ).toBe("source");
    expect(
      workshopManifestSchema.parse(manifest("template", "template.yaml")).kind,
    ).toBe("template");
  });

  it("rejects a wrong entry filename for new kinds", () => {
    expect(
      workshopManifestSchema.safeParse(manifest("pipeline", "workflow.yaml"))
        .success,
    ).toBe(false);
    expect(
      workshopManifestSchema.safeParse(manifest("template", "team.yaml"))
        .success,
    ).toBe(false);
  });

  it("keeps legacy kinds on free-form entries", () => {
    expect(
      workshopManifestSchema.safeParse(manifest("workflow", "flows/demo.yaml"))
        .success,
    ).toBe(true);
  });

  it("rejects path traversal for new kinds", () => {
    expect(
      workshopManifestSchema.safeParse({
        ...manifest("pipeline", "../pipeline.yaml"),
        files: ["../pipeline.yaml"],
      }).success,
    ).toBe(false);
  });
});

describe("source asset envelope", () => {
  it("accepts a minimal source entry", () => {
    expect(
      sourceAssetSchema.safeParse({
        apiVersion: "agentteam/source/v1",
        kind: "Source",
        metadata: { name: "hackernews", version: "1.0.0" },
        spec: { type: "rss" },
        extra: true,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown source type", () => {
    expect(
      sourceAssetSchema.safeParse({
        apiVersion: "agentteam/source/v1",
        kind: "Source",
        metadata: { name: "hackernews", version: "1.0.0" },
        spec: { type: "ftp" },
      }).success,
    ).toBe(false);
  });
});
