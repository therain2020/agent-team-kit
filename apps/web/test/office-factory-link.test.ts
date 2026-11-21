import type { RunProjection, WorldSnapshot } from "@kit/store";
import { describe, expect, it } from "vitest";
import {
  type FactoryItem,
  type FactoryLink,
  factoryLinkFrom,
  missingPausedRunIds,
  pendingCountOf,
  producerAgentIdFromArtifacts,
  reconcileFactoryLink,
} from "../lib/factory";
import {
  officeAgentHref,
  officeLinkProblem,
  parseOfficeRoomParams,
  resolveInitialAgent,
} from "../lib/office-deeplink";

function item(
  kind: FactoryItem["kind"],
  id: string,
  risk: FactoryItem["riskClass"] = "low",
): FactoryItem {
  return {
    kind,
    requestId: kind === "approval" ? id : undefined,
    runId: `run-${id}`,
    riskClass: risk,
    summary: id,
    costCny: 0,
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}

function run(runId: string, status: string): RunProjection {
  return {
    runId,
    workspaceId: "default",
    workflowId: "wf",
    status,
    currentStage: null,
    progress: 0,
    costCny: 0,
    tokens: 0,
    artifactCount: 0,
    waitReason: null,
    lastEventId: 1,
    version: 1,
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}

function world(...runs: RunProjection[]): WorldSnapshot {
  return { runs, agents: [], computedAt: "2026-11-21T00:00:00.000Z" };
}

describe("factory pending count", () => {
  it("counts approvals only and ignores failed runs", () => {
    expect(
      pendingCountOf([
        item("approval", "a"),
        item("failed", "b", "high"),
        item("approval", "c", "medium"),
      ]),
    ).toBe(2);
    expect(pendingCountOf([])).toBe(0);
  });

  it("projects the door plate from the gate order and caps the top items", () => {
    const link = factoryLinkFrom({
      items: [
        item("approval", "low", "low"),
        item("failed", "failed", "high"),
        item("approval", "high", "high"),
        item("approval", "medium", "medium"),
        item("approval", "extra", "low"),
      ],
      stations: [],
      generatedAt: "2026-11-21T00:00:00.000Z",
    });
    expect(link.pendingCount).toBe(4);
    expect(link.topItems.map((entry) => entry.requestId)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("follows the stream: paused runs move the count; stale top items drop", () => {
    const link: FactoryLink = {
      pendingCount: 2,
      topItems: [
        {
          requestId: "req-a",
          runId: "run_a",
          summary: "a",
          riskClass: "low",
        },
        {
          requestId: "req-b",
          runId: "run_b",
          summary: "b",
          riskClass: "low",
        },
      ],
      generatedAt: "2026-11-21T00:00:00.000Z",
    };
    const next = reconcileFactoryLink(
      link,
      world(run("run_a", "running"), run("run_b", "paused")),
    );
    expect(next.pendingCount).toBe(1);
    expect(next.topItems.map((entry) => entry.runId)).toEqual(["run_b"]);
    expect(reconcileFactoryLink(link, null)).toBe(link);
  });

  it("flags paused runs the line does not know about yet", () => {
    expect(
      missingPausedRunIds(
        [item("approval", "known")],
        world(
          run("run-known", "running"),
          run("run-known", "paused"),
          run("run-new", "paused"),
        ),
      ),
    ).toEqual(["run-new"]);
    expect(missingPausedRunIds([], null)).toEqual([]);
  });
});

describe("producer resolution", () => {
  const draft = {
    artifactId: "draft",
    createdAt: "2026-11-21T00:01:00.000Z",
    producerAgentId: "builder",
  };
  const older = {
    artifactId: "older",
    createdAt: "2026-11-21T00:00:00.000Z",
    producerAgentId: "seller",
  };
  const newest = {
    artifactId: "newest",
    createdAt: "2026-11-21T00:02:00.000Z",
    producerAgentId: "specialist",
  };

  it("prefers the approval draft, then the newest manifest", () => {
    expect(producerAgentIdFromArtifacts([older, draft, newest], "draft")).toBe(
      "builder",
    );
    expect(producerAgentIdFromArtifacts([older, newest])).toBe("specialist");
    expect(producerAgentIdFromArtifacts([newest, older])).toBe("specialist");
  });

  it("falls back to the newest artifact when the draft has no producer", () => {
    expect(
      producerAgentIdFromArtifacts(
        [older, { ...draft, producerAgentId: null }, newest],
        "draft",
      ),
    ).toBe("specialist");
    expect(producerAgentIdFromArtifacts([older], "missing")).toBe("seller");
  });

  it("returns null instead of guessing", () => {
    expect(producerAgentIdFromArtifacts([])).toBeNull();
    expect(
      producerAgentIdFromArtifacts([
        {
          artifactId: "synthetic",
          createdAt: "2026-11-21T00:00:00.000Z",
          producerAgentId: "workflow",
        },
        {
          artifactId: "blank",
          createdAt: "2026-11-21T00:01:00.000Z",
          producerAgentId: "  ",
        },
      ]),
    ).toBeNull();
  });
});

describe("cross-room deep links", () => {
  it("normalises pack/agent parameters", () => {
    expect(
      parseOfficeRoomParams({ pack: [" demo ", "other"], agent: "builder" }),
    ).toEqual({ pack: "demo", agent: "builder" });
    expect(parseOfficeRoomParams({ pack: "", agent: "   " })).toEqual({
      pack: null,
      agent: null,
    });
    expect(parseOfficeRoomParams({})).toEqual({ pack: null, agent: null });
  });

  it("validates against the loaded packs and roster", () => {
    const data = {
      packs: [{ dirName: "demo" }],
      active: { agents: [{ id: "builder" }] },
    };
    expect(officeLinkProblem({ pack: null, agent: null }, data)).toBeNull();
    expect(
      officeLinkProblem({ pack: "demo", agent: "builder" }, data),
    ).toBeNull();
    expect(officeLinkProblem({ pack: "ghost", agent: null }, data)).toBe(
      "pack",
    );
    expect(officeLinkProblem({ pack: null, agent: "ghost" }, data)).toBe(
      "agent",
    );
  });

  it("selects the requested station only when it exists", () => {
    expect(
      resolveInitialAgent([{ id: "manager" }, { id: "builder" }], "builder"),
    ).toBe("builder");
    expect(
      resolveInitialAgent([{ id: "manager" }, { id: "builder" }], "ghost"),
    ).toBe("manager");
    expect(resolveInitialAgent([], "ghost")).toBe("manager");
    expect(officeAgentHref("builder")).toBe("/office?agent=builder");
    expect(officeAgentHref("a b")).toBe("/office?agent=a+b");
  });
});
