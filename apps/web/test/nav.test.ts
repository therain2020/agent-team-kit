import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS } from "../lib/legacy-redirects";
import {
  NAV_ITEMS,
  QUICK_JUMP,
  isNavItemActive,
  matchNavItem,
  quickJumpHref,
  shortcutLabel,
} from "../lib/nav";

const CONSOLE_DIR = fileURLToPath(new URL("../app/(console)", import.meta.url));

function pageRoutes(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...pageRoutes(full));
    } else if (entry.name === "page.tsx") {
      const rel = path.relative(CONSOLE_DIR, dir).replace(/\\/g, "/");
      found.push(rel ? `/${rel}` : "/");
    }
  }
  return found;
}

describe("console IA (#160)", () => {
  it("exposes the first-class entries plus the trigger plane and observer surfaces", () => {
    // 96 §5.5 adds the observation (`/jobs`) and control (`/triggers`) entries;
    // 98 I-8 adds the read-only observer entry.
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/office",
      "/world",
      "/observer",
      "/approvals",
      "/workshop",
      "/evolution",
      "/ops",
      "/jobs",
      "/triggers",
    ]);
  });

  it("keeps the approval badge on Approvals only", () => {
    const badged = NAV_ITEMS.filter((item) => item.badge).map((i) => i.href);
    expect(badged).toEqual(["/approvals"]);
  });

  it("binds a unique `g` quick-jump letter to every entry", () => {
    const shortcuts = NAV_ITEMS.map((item) => item.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    for (const item of NAV_ITEMS) {
      expect(QUICK_JUMP.get(item.shortcut)).toBe(item.href);
      expect(quickJumpHref(item.shortcut)).toBe(item.href);
      expect(shortcutLabel(item)).toBe(`g ${item.shortcut}`);
    }
    expect(quickJumpHref("x")).toBeNull();
  });

  it("matches a primary route and its nested children", () => {
    expect(matchNavItem("/world")?.href).toBe("/world");
    expect(matchNavItem("/office/any/depth")?.href).toBe("/office");
    expect(matchNavItem("/approvals/queue")?.href).toBe("/approvals");
  });

  it("folds the local libraries into the workshop surface (88 M2)", () => {
    const workshop = NAV_ITEMS.find((item) => item.href === "/workshop");
    expect(workshop?.aliases).toEqual(["/packs", "/sources"]);
    if (!workshop) {
      return;
    }
    expect(matchNavItem("/packs")).toBe(workshop);
    expect(matchNavItem("/sources")).toBe(workshop);
    expect(matchNavItem("/packs/demo/studio")).toBe(workshop);
    expect(isNavItemActive(workshop, "/workshop")).toBe(true);
    expect(isNavItemActive(workshop, "/sources/e2e")).toBe(true);
    expect(isNavItemActive(workshop, "/world")).toBe(false);
  });

  it("keeps app/(console) at thirteen page routes or fewer", () => {
    const routes = pageRoutes(CONSOLE_DIR).sort();
    expect(routes.length).toBeLessThanOrEqual(13);
    expect(routes).toEqual([
      "/approvals",
      "/evolution",
      "/jobs",
      "/observer",
      "/office",
      "/ops",
      "/packs",
      "/packs/[dirName]/studio",
      "/sources",
      "/traces",
      "/triggers",
      "/workshop",
      "/world",
    ]);
  });

  it("keeps no dead links: every legacy route redirects onto a live route", () => {
    const liveBases = new Set(
      NAV_ITEMS.map((item) => item.href).concat([
        "/packs",
        "/sources",
        "/traces",
      ]),
    );
    const bySource = new Map(
      LEGACY_REDIRECTS.map((entry) => [entry.source, entry.destination]),
    );

    // Every removed first-class route is covered by the redirect table.
    for (const legacy of [
      "/",
      "/activity",
      "/autopilot",
      "/budgets",
      "/degradation",
      "/factory",
      "/inbox",
      "/iterations",
      "/kill-switch",
      "/manager",
      "/runs",
    ]) {
      expect(bySource.has(legacy), legacy).toBe(true);
    }

    // Dynamic bookmark routes are covered too.
    expect(bySource.has("/inbox/:requestId")).toBe(true);
    expect(bySource.has("/iterations/:iterationId")).toBe(true);
    expect(bySource.has("/packs/new")).toBe(true);
    expect(bySource.has("/packs/:dirName")).toBe(true);
    expect(bySource.has("/runs/:runId")).toBe(true);

    // And every destination lands on a first-class (or drill-down) surface.
    for (const entry of LEGACY_REDIRECTS) {
      const base = entry.destination.split("?")[0] ?? "";
      expect(
        liveBases.has(base),
        `${entry.source} → ${entry.destination}`,
      ).toBe(true);
    }
  });
});
