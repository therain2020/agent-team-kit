import { describe, expect, it } from "vitest";
import {
  allowedByApplyMode,
  assessChangedFiles,
  classifyChangedFile,
  classifyIterationRisk,
  evaluateIterationApply,
  resolveIterationApplyMode,
} from "../src/iteration-policy";

describe("classifyChangedFile", () => {
  it("marks agent instructions as proposal-only substrate", () => {
    const verdict = classifyChangedFile("packs/self-improve/agents/patcher.md");
    expect(verdict).toMatchObject({
      category: "instructions",
      risk: "high",
      forbidden: true,
      requiresApproval: true,
    });
  });

  it("marks pack skills and top-level skills as proposal-only substrate", () => {
    for (const file of [
      "packs/tech-radar/skills/research/SKILL.md",
      "skills/copywriting/SKILL.md",
    ]) {
      expect(classifyChangedFile(file)).toMatchObject({
        category: "instructions",
        forbidden: true,
      });
    }
  });

  it("marks workflows and orchestration yaml as high + approval", () => {
    for (const file of [
      "packs/tech-radar/workflows/daily.yaml",
      "packs/tech-radar/team.yaml",
      "packs/tech-radar/autopilot.yaml",
      "packs/tech-radar/policies.yaml",
      "packs/tech-radar/iteration.yaml",
    ]) {
      expect(classifyChangedFile(file)).toMatchObject({
        category: "orchestration",
        risk: "high",
        forbidden: false,
        requiresApproval: true,
      });
    }
  });

  it("keeps code, tests, docs, and i18n on their existing tiers", () => {
    expect(classifyChangedFile("packages/core/src/workflow.ts").risk).toBe(
      "high",
    );
    expect(classifyChangedFile("apps/cli/src/commands/job.ts").risk).toBe(
      "medium",
    );
    expect(classifyChangedFile("apps/web/app/(console)/page.tsx").risk).toBe(
      "medium",
    );
    expect(classifyChangedFile("docs/open-platform.md").risk).toBe("low");
    expect(classifyChangedFile("packs/self-improve/README.md").risk).toBe(
      "low",
    );
    expect(classifyChangedFile("packages/core/test/x.test.ts").risk).toBe(
      "low",
    );
    expect(classifyChangedFile("apps/web/messages/en.json").risk).toBe("low");
  });

  it("keeps forbidden filesystem paths forbidden", () => {
    expect(classifyChangedFile(".env")).toMatchObject({
      category: "forbidden",
      forbidden: true,
    });
  });
});

describe("assessChangedFiles", () => {
  it("aggregates the highest risk and the substrate protection", () => {
    const assessment = assessChangedFiles([
      "docs/readme.md",
      "packages/core/src/workflow.ts",
      "packs/self-improve/agents/patcher.md",
    ]);
    expect(assessment.risk).toBe("high");
    expect(assessment.forbidden).toBe(true);
    expect(assessment.protection).toBe("instructions");
    expect(assessment.protectedPaths).toEqual([
      "packs/self-improve/agents/patcher.md",
    ]);
  });

  it("treats an empty change set as low risk", () => {
    const assessment = assessChangedFiles([]);
    expect(assessment.risk).toBe("low");
    expect(assessment.forbidden).toBe(false);
    expect(assessment.protection).toBe("none");
  });
});

describe("classifyIterationRisk", () => {
  it("escalates agent instruction edits beyond the planned risk", () => {
    const result = classifyIterationRisk(
      ["packs/self-improve/agents/patcher.md"],
      "low",
      "high",
    );
    expect(result.risk).toBe("high");
    expect(result.forbidden).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("applies the domain ceiling after substrate escalation", () => {
    const result = classifyIterationRisk(
      ["packs/tech-radar/workflows/daily.yaml"],
      "low",
      "medium",
    );
    expect(result.risk).toBe("high");
    expect(result.reasons).toContain("exceeds domain risk ceiling medium");
  });
});

describe("allowedByApplyMode", () => {
  it("never auto-applies high risk", () => {
    expect(allowedByApplyMode("high", "low-medium")).toBe(false);
  });

  it("keeps the existing low and medium rules", () => {
    expect(allowedByApplyMode("low", "low")).toBe(true);
    expect(allowedByApplyMode("medium", "low")).toBe(false);
    expect(allowedByApplyMode("medium", "low-medium")).toBe(true);
    expect(allowedByApplyMode("low", "none")).toBe(false);
  });
});

describe("evaluateIterationApply", () => {
  it("blocks --apply low-medium when agents are changed (end-to-end gate)", () => {
    const decision = evaluateIterationApply({
      runMode: "LIVE",
      applyMode: "low-medium",
      risk: "medium",
      changedFiles: ["docs/readme.md", "packs/self-improve/agents/patcher.md"],
    });
    expect(decision.action).toBe("block");
    expect(decision.reason).toContain("agent/skill instructions");
    expect(decision.substrate.protectedPaths).toEqual([
      "packs/self-improve/agents/patcher.md",
    ]);
  });

  it("blocks --apply low-medium when skills are changed", () => {
    const decision = evaluateIterationApply({
      runMode: "LIVE",
      applyMode: "low-medium",
      risk: "low",
      changedFiles: ["skills/copywriting/SKILL.md"],
    });
    expect(decision.action).toBe("block");
  });

  it("parks orchestration changes for approval instead of applying", () => {
    const decision = evaluateIterationApply({
      runMode: "LIVE",
      applyMode: "low-medium",
      risk: "medium",
      changedFiles: ["packs/tech-radar/workflows/daily.yaml"],
    });
    expect(decision.action).toBe("skip");
    expect(decision.effectiveRisk).toBe("high");
    expect(decision.substrate.requiresApproval).toBe(true);
  });

  it("keeps low-risk docs auto-appliable", () => {
    const decision = evaluateIterationApply({
      runMode: "LIVE",
      applyMode: "low",
      risk: "low",
      changedFiles: ["docs/readme.md", "apps/web/messages/en.json"],
    });
    expect(decision.action).toBe("apply");
  });

  it("still skips medium risk in low mode", () => {
    const decision = evaluateIterationApply({
      runMode: "LIVE",
      applyMode: "low",
      risk: "medium",
      changedFiles: ["apps/cli/src/commands/job.ts"],
    });
    expect(decision.action).toBe("skip");
  });

  it("never applies in a dry run", () => {
    const decision = evaluateIterationApply({
      runMode: "DRY_RUN",
      applyMode: "low-medium",
      risk: "low",
      changedFiles: ["docs/readme.md"],
    });
    expect(decision.action).toBe("skip");
  });
});

describe("resolveIterationApplyMode", () => {
  it("keeps LIVE modes and forces none for dry runs", () => {
    expect(resolveIterationApplyMode("LIVE", "low-medium")).toBe("low-medium");
    expect(resolveIterationApplyMode("DRY_RUN", "low-medium")).toBe("none");
  });
});
