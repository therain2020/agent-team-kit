import { describe, expect, it } from "vitest";
import {
  extractTitleSummary,
  findSecret,
  mergeSiteIndex,
  renderMarkdown,
  renderRunFiles,
  renderSiteIndex,
  stripLeadingHeading,
} from "../src/index";
import type { PublishedRun } from "../src/types";

function sampleRun(runId: string, createdAt: string): PublishedRun {
  const artifactId = `art_${runId}`;
  return {
    runId,
    title: "Weekly radar",
    summary: "A short technology radar brief.",
    workflowId: "daily-radar",
    workspaceId: "default",
    status: "succeeded",
    runMode: "DRY_RUN",
    createdAt,
    updatedAt: createdAt,
    costCny: 0.0932,
    tokens: 2100,
    durationMs: 65_000,
    stages: [
      {
        stageId: `${runId}:writer`,
        name: "writer",
        status: "succeeded",
        startedAt: createdAt,
        finishedAt: createdAt,
        artifactIds: [artifactId],
      },
    ],
    artifacts: [
      {
        artifactId,
        version: 1,
        kind: "report",
        title: "Weekly radar",
        summary: "A short technology radar brief.",
        stageId: `${runId}:writer`,
        stageName: "writer",
        agentId: "writer",
        modelId: "deepseek-pro",
        createdAt,
        costCny: 0.0932,
        tokens: 2100,
        markdown:
          "## Weekly radar\n\n| Item | Signal |\n|---|---|\n| Agents | **Strong** |\n\n```ts\nconst x = 1;\n```",
        raw: "## Weekly radar\n\n| Item | Signal |\n|---|---|\n| Agents | **Strong** |\n\n```ts\nconst x = 1;\n```",
        truncated: false,
      },
    ],
  };
}

describe("markdown rendering", () => {
  it("renders GFM tables and code blocks", () => {
    const html = renderMarkdown(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<code");
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not render javascript links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain('href="javascript:');
  });

  it("turns images into links", () => {
    const html = renderMarkdown("![alt](https://example.com/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("https://example.com/a.png");
    expect(html).toContain(">alt</a>");
  });

  it("extracts a title and summary", () => {
    const { title, summary } = extractTitleSummary(
      "## Weekly radar\n\nA short **brief** with a [link](https://example.com).\n\nSecond paragraph.",
    );
    expect(title).toBe("Weekly radar");
    expect(summary).toBe("A short brief with a link.");
  });

  it("strips a leading heading that duplicates the page title", () => {
    expect(
      stripLeadingHeading("## Weekly radar\n\nBody text", "Weekly radar"),
    ).toBe("Body text");
    expect(
      stripLeadingHeading("## Other heading\n\nBody text", "Weekly radar"),
    ).toContain("Other heading");
  });

  it("skips tables and fenced code when extracting the summary", () => {
    const { title, summary } = extractTitleSummary(
      "## Report\n\n| Field | Value |\n|---|---|\n| a | b |\n\nThe real summary follows.",
    );
    expect(title).toBe("Report");
    expect(summary).toBe("The real summary follows.");

    expect(extractTitleSummary('```json\n{"a":1}\n```').title).toBe("");
  });
});

describe("publish safety", () => {
  it("flags high-confidence secrets", () => {
    expect(findSecret(`key sk-${"a".repeat(24)}`)).toBe("API key");
    expect(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(
      "private key",
    );
    expect(findSecret("ordinary report text")).toBeNull();
  });
});

describe("site rendering", () => {
  it("renders run files with provenance and markdown", () => {
    const run = sampleRun("run_1", "2026-11-14T00:00:00.000Z");
    const files = renderRunFiles(run, {
      title: "Published runs",
      description: "Archive",
    });
    const runPage = files["runs/run_1/index.html"];
    const artifactPage = files["runs/run_1/art_run_1.html"];

    expect(runPage).toContain("Weekly radar");
    expect(runPage).toContain("writer");
    expect(runPage).toContain("Artifacts");
    expect(artifactPage).toContain("<table>");
    expect(artifactPage).toContain("Provenance");
    expect(artifactPage).toContain("Raw Markdown");
    expect(artifactPage).toContain("deepseek-pro");
  });

  it("escapes metadata and artifact filenames", () => {
    const run = sampleRun("run_1", "2026-11-14T00:00:00.000Z");
    run.title = "<script>alert(1)</script>";
    const files = renderRunFiles(run, {
      title: "Published runs",
      description: "Archive",
    });
    expect(files["runs/run_1/index.html"]).not.toContain("<script>alert");
    expect(files["runs/run_1/index.html"]).toContain("&lt;script&gt;");
  });

  it("merges runs into a sorted archive index", () => {
    const older = sampleRun("run_old", "2026-11-13T00:00:00.000Z");
    const newer = sampleRun("run_new", "2026-11-14T00:00:00.000Z");
    const options = { title: "Published runs", description: "Archive" };

    const first = mergeSiteIndex(null, older, options);
    const second = mergeSiteIndex(first, newer, options);

    expect(second.runs.map((run) => run.runId)).toEqual(["run_new", "run_old"]);
    const html = renderSiteIndex(second, options);
    expect(html).toContain("Weekly radar");
    expect(html).toContain('href="runs/run_new/index.html"');
    expect(html).toContain('href="runs/run_old/index.html"');
  });
});
