import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS } from "../lib/legacy-redirects";
import {
  type WorkshopPackView,
  type WorkshopSourceView,
  linkedSourceView,
  matchSourceNames,
  parseWorkshopTab,
  pickSelectedPack,
} from "../lib/workshop-link";

function source(name: string, builtin = false): WorkshopSourceView {
  return {
    name,
    version: builtin ? "builtin" : "1.0.0",
    description: "",
    repo: "acme/source",
    commit: "abcdef1234567",
    trust: builtin ? "builtin" : "third-party",
    builtin,
  };
}

function pack(
  dirName: string,
  usedSources: string[],
  valid = true,
): WorkshopPackView {
  return {
    dirName,
    name: dirName,
    version: "1.0.0",
    description: "",
    valid,
    errors: valid ? [] : ["team.yaml parse error"],
    warnings: [],
    agentCount: 1,
    skillCount: 0,
    workflowCount: 0,
    policyCount: 0,
    workflows: [],
    roles: [],
    skills: [],
    usedSources,
  };
}

describe("workshop surface linking", () => {
  const sources = [
    source("arxiv", true),
    source("hn", true),
    source("github", true),
    source("tech-blog"),
  ];

  it("matches source names on word boundaries, case-insensitively", () => {
    expect(matchSourceNames("Fetch news from HN daily.", ["hn"])).toEqual([
      "hn",
    ]);
    expect(
      matchSourceNames("Pull https://export.arxiv.org/rss/cs.AI", ["arxiv"]),
    ).toEqual(["arxiv"]);
    expect(matchSourceNames("mentioned in a sentence", ["hn"])).toEqual([]);
    expect(matchSourceNames("uses techno stack, no hit", ["tech"])).toEqual([]);
    expect(
      matchSourceNames("two: tech-blog and hn", ["tech-blog", "hn"]),
    ).toEqual(["hn", "tech-blog"]);
  });

  it("scopes the source column to the selected pack", () => {
    const selected = pack("radar", ["arxiv", "tech-blog"]);
    const linked = linkedSourceView(selected, sources, "pack");
    expect(linked.scoped).toBe(true);
    expect(linked.visible.map((entry) => entry.name)).toEqual([
      "arxiv",
      "tech-blog",
    ]);

    const everything = linkedSourceView(selected, sources, "all");
    expect(everything.scoped).toBe(false);
    expect(everything.visible).toHaveLength(4);
  });

  it("falls back to every source when the pack names none", () => {
    const linked = linkedSourceView(pack("quiet", []), sources, "pack");
    expect(linked.scoped).toBe(false);
    expect(linked.visible).toHaveLength(4);
    expect(linkedSourceView(null, sources, "pack").visible).toHaveLength(4);
  });

  it("picks the requested pack, else the first valid one", () => {
    const packs = [pack("broken", [], false), pack("radar", ["arxiv"])];
    expect(pickSelectedPack(packs, "broken")?.dirName).toBe("broken");
    expect(pickSelectedPack(packs, "missing")?.dirName).toBe("radar");
    expect(pickSelectedPack(packs, undefined)?.dirName).toBe("radar");
    expect(pickSelectedPack([], "radar")).toBeNull();
  });

  it("parses legacy tab parameters", () => {
    expect(parseWorkshopTab("sources")).toBe("sources");
    expect(parseWorkshopTab("assembly")).toBe("assembly");
    expect(parseWorkshopTab("packs")).toBe("packs");
    expect(parseWorkshopTab(undefined)).toBe("packs");
    expect(parseWorkshopTab("nope")).toBe("packs");
  });
});

describe("legacy console routes", () => {
  it("redirects the old first-class pages into the consolidated surfaces", () => {
    const bySource = new Map(
      LEGACY_REDIRECTS.map((entry) => [entry.source, entry.destination]),
    );
    expect(bySource.get("/packs")).toBe("/workshop?tab=packs");
    expect(bySource.get("/sources")).toBe("/workshop?tab=sources");
    expect(bySource.get("/manager")).toBe("/office?panel=manager");
  });
});
