import { describe, expect, it } from "vitest";
import { renderSite } from "../src/publish-render";

describe("publish render", () => {
  it("renders an index and escapes artifact HTML", () => {
    const site = renderSite({
      runId: "run_1",
      workflowId: "tech-radar",
      status: "succeeded",
      createdAt: "2026-11-15T00:00:00.000Z",
      artifacts: [
        {
          artifactId: "art_1",
          stageId: "run_1:writer",
          createdAt: "2026-11-15T00:00:01.000Z",
          text: "<script>alert(1)</script>",
        },
      ],
    });

    expect(site.index).toContain("art_1.html");
    expect(site.index).toContain("tech-radar");
    expect(site.pages["art_1.html"]).toContain("&lt;script&gt;");
    expect(site.pages["art_1.html"]).not.toContain("<script>alert");
  });

  it("keeps artifact file names path-safe", () => {
    const site = renderSite({
      runId: "run_1",
      workflowId: "wf",
      status: "succeeded",
      createdAt: "now",
      artifacts: [
        {
          artifactId: "../../evil",
          stageId: "stage",
          createdAt: "now",
          text: "safe",
        },
      ],
    });

    expect(Object.keys(site.pages)).toEqual(["evil.html"]);
  });
});
