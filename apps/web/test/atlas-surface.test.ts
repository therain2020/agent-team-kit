import { describe, expect, it } from "vitest";
import { atlasHref, parseWorldSearchParams } from "../lib/world-view";

/**
 * Atlas is a `/world` drill-down (issue #160), reached via `?tab=atlas`
 * (issue #145). These tests pin the URL contract shared by the server page,
 * the run drawer button, the run selector and the evidence chain.
 */
describe("atlas surface on /world (#145, #160)", () => {
  it("parses the atlas tab with run and artifact deep links", () => {
    expect(
      parseWorldSearchParams({
        tab: "atlas",
        run: "run_1",
        artifact: "out/a.txt@v2",
      }),
    ).toEqual({
      tab: "atlas",
      runId: "run_1",
      artifactKey: "out/a.txt@v2",
    });
  });

  it("trims values, flattens arrays and drops empty params", () => {
    expect(
      parseWorldSearchParams({
        tab: ["atlas"],
        run: ["  run_2 "],
        artifact: "   ",
      }),
    ).toEqual({ tab: "atlas", runId: "run_2" });
    expect(parseWorldSearchParams({})).toEqual({ tab: "" });
  });

  it("builds deep-linkable atlas hrefs that never leave /world", () => {
    expect(atlasHref()).toBe("/world?tab=atlas");
    expect(atlasHref({ runId: "run_1" })).toBe("/world?tab=atlas&run=run_1");
    expect(atlasHref({ runId: "run_1", artifactKey: "out/a b.txt@v2" })).toBe(
      "/world?tab=atlas&run=run_1&artifact=out%2Fa%20b.txt%40v2",
    );
  });
});
