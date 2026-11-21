import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_HREF,
  LIBRARY_HREF,
  WORKSHOP_ASSET_KINDS,
  activeLibraryTab,
  installDestination,
  manifestAssetKind,
  matchesAssetKind,
  parseAssetKind,
} from "../lib/workshop-library";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));

function sourcesIn(...dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(path.join(WEB_DIR, dir), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        found.push(...sourcesIn(path.join(dir, entry.name)));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        found.push(path.join(WEB_DIR, dir, entry.name));
      }
    }
  }
  return found;
}

function relative(file: string): string {
  return path.relative(WEB_DIR, file).replace(/\\/g, "/");
}

describe("workshop asset partitions (88 §3.4 M2)", () => {
  it("keeps the five discovery partitions in display order", () => {
    expect(WORKSHOP_ASSET_KINDS).toEqual([
      "pack",
      "pipeline",
      "source",
      "component",
      "template",
    ]);
  });

  it("maps manifest kinds onto partitions", () => {
    expect(manifestAssetKind("pack")).toBe("pack");
    expect(manifestAssetKind("pipeline")).toBe("pipeline");
    expect(manifestAssetKind("source")).toBe("source");
    expect(manifestAssetKind("template")).toBe("template");
    for (const component of ["agent", "workflow", "toolpack", "skillpack"]) {
      expect(manifestAssetKind(component)).toBe("component");
    }
    expect(manifestAssetKind("unknown-kind")).toBeNull();
  });

  it("filters search results by partition", () => {
    expect(matchesAssetKind("toolpack", "component")).toBe(true);
    expect(matchesAssetKind("workflow", "component")).toBe(true);
    expect(matchesAssetKind("toolpack", "pack")).toBe(false);
    expect(matchesAssetKind("source", "source")).toBe(true);
    expect(matchesAssetKind("nope", "source")).toBe(false);
  });

  it("parses the discovery kind query parameter", () => {
    expect(parseAssetKind("source")).toBe("source");
    expect(parseAssetKind("component")).toBe("component");
    expect(parseAssetKind("nope")).toBe("pack");
    expect(parseAssetKind(undefined)).toBe("pack");
  });

  it("routes each partition to its local library and back", () => {
    expect(LIBRARY_HREF.pack).toBe("/packs");
    expect(LIBRARY_HREF.source).toBe("/sources");
    expect(DISCOVERY_HREF.pack).toBe("/workshop?kind=pack");
    expect(DISCOVERY_HREF.source).toBe("/workshop?kind=source");
    for (const kind of WORKSHOP_ASSET_KINDS) {
      expect(DISCOVERY_HREF[kind].startsWith("/workshop?kind=")).toBe(true);
    }
  });

  it("names the install destination for each partition", () => {
    expect(installDestination("pack", "radar")).toBe("packs/radar");
    expect(installDestination("source", "hn-pro")).toBe("sources/hn-pro");
    expect(installDestination("template", "research")).toBe(
      "templates/research",
    );
    expect(installDestination("component", "writer")).toContain("writer");
  });

  it("marks the library switcher tab from the pathname", () => {
    expect(activeLibraryTab("/workshop")).toBe("discover");
    expect(activeLibraryTab("/packs")).toBe("packs");
    expect(activeLibraryTab("/packs/demo/studio")).toBe("packs");
    expect(activeLibraryTab("/sources")).toBe("sources");
    expect(activeLibraryTab("/world")).toBe("discover");
  });
});

describe("workshop IA invariants", () => {
  it("keeps publishing in exactly one place: the Studio pack panel", () => {
    const files = sourcesIn(
      "components/workshop",
      "components/studio",
      "app/(console)/workshop",
      "app/(console)/packs",
      "app/(console)/sources",
    );
    const hits = files
      .filter((file) =>
        readFileSync(file, "utf8").includes("/api/workshop/publish"),
      )
      .map(relative);
    expect(hits).toEqual(["components/studio/pack-publish.tsx"]);
  });

  it("links every local library into the discovery center", () => {
    const packView = readFileSync(
      path.join(WEB_DIR, "components/workshop/pack-library-view.tsx"),
      "utf8",
    );
    const sourcesPage = readFileSync(
      path.join(WEB_DIR, "app/(console)/sources/page.tsx"),
      "utf8",
    );
    expect(packView).toContain("DISCOVERY_HREF.pack");
    expect(sourcesPage).toContain("DISCOVERY_HREF.source");
  });
});
