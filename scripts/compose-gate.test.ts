import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPOSE_KINDS,
  MANIFEST_PATH,
  REQUIRED_FALLBACK,
  REQUIRED_REVIEW,
  collectWebSourceFiles,
  evaluateComposeGate,
  isDialogLikeSurface,
  postsToCompose,
  validateManifest,
} from "./compose-gate";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readFrom(files: Record<string, string>) {
  return (file: string): string | null => files[file] ?? null;
}

function manifestWith(surfaces: unknown[]): unknown {
  return { version: 1, surfaces };
}

function composeSurface(files: string[], kinds: string[] = ["mission"]) {
  return {
    id: "T-1",
    label: "Test surface",
    files,
    status: "compose",
    composeKinds: kinds,
    fallback: REQUIRED_FALLBACK,
    review: REQUIRED_REVIEW,
  };
}

describe("detection scope", () => {
  it("treats dialog, wizard and form components as input surfaces", () => {
    expect(
      isDialogLikeSurface(
        "apps/web/components/office/quick-mission-dialog.tsx",
      ),
    ).toBe(true);
    expect(
      isDialogLikeSurface("apps/web/components/studio/config-wizard.tsx"),
    ).toBe(true);
    expect(
      isDialogLikeSurface("apps/web/components/ops/alert-rule-form.tsx"),
    ).toBe(true);
    expect(
      isDialogLikeSurface("apps\\web\\components\\office\\quick-dialog.tsx"),
    ).toBe(true);
  });

  it("ignores shared primitives, plain components and non-tsx files", () => {
    expect(isDialogLikeSurface("apps/web/components/ui/dialog.tsx")).toBe(
      false,
    );
    expect(isDialogLikeSurface("apps/web/components/kit/empty-state.tsx")).toBe(
      false,
    );
    expect(
      isDialogLikeSurface("apps/web/components/layout/command-palette.tsx"),
    ).toBe(false);
    expect(isDialogLikeSurface("apps/web/app/(console)/office/page.tsx")).toBe(
      false,
    );
  });

  it("treats /api/compose callers as input surfaces regardless of name", () => {
    expect(
      postsToCompose(
        "apps/web/components/sources/new-market-panel.tsx",
        'fetch("/api/compose", { method: "POST" })',
      ),
    ).toBe(true);
    expect(
      postsToCompose(
        "apps/web/app/(console)/packs/new/page.tsx",
        'fetch("/api/compose")',
      ),
    ).toBe(true);
    expect(postsToCompose("docs/compose-gate.md", "POST /api/compose")).toBe(
      false,
    );
    expect(
      postsToCompose("apps/web/app/api/compose/route.ts", "/api/compose"),
    ).toBe(false);
  });
});

describe("compose gate", () => {
  it("passes unrelated PRs", () => {
    const manifest = manifestWith([
      composeSurface(["apps/web/components/office/new-mission-dialog.tsx"]),
    ]);
    const report = evaluateComposeGate({
      manifest,
      changedFiles: [
        "packages/core/src/index.ts",
        "apps/web/components/ui/dialog.tsx",
        "apps/web/components/layout/topbar.tsx",
        "apps/web/app/api/compose/route.ts",
        "docs/compose-gate.md",
        "scripts/compose-gate.ts",
      ],
      readFile: readFrom({
        "apps/web/components/office/new-mission-dialog.tsx": "<Dialog />",
        "apps/web/components/ui/dialog.tsx": "export function Dialog() {}",
        "apps/web/components/layout/topbar.tsx": "export function Topbar() {}",
        "apps/web/app/api/compose/route.ts": 'fetch("/api/compose")',
        "docs/compose-gate.md": "POST /api/compose",
        "packages/core/src/index.ts": "",
        "scripts/compose-gate.ts": "",
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });

  it("fails a new dialog-shaped surface without a declaration", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        composeSurface(["apps/web/components/office/new-mission-dialog.tsx"]),
      ]),
      changedFiles: ["apps/web/components/office/quick-start-form.tsx"],
      readFile: readFrom({
        "apps/web/components/office/new-mission-dialog.tsx": "<Dialog />",
        "apps/web/components/office/quick-start-form.tsx": "<form />",
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered).toEqual([
      "apps/web/components/office/quick-start-form.tsx",
    ]);
    expect(report.errors.join("\n")).toContain(
      "no declaration in .github/compose-gate/input-surfaces.json",
    );
  });

  it("fails a new /api/compose caller without a declaration", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        composeSurface(["apps/web/components/office/new-mission-dialog.tsx"]),
      ]),
      changedFiles: ["apps/web/components/sources/instant-install.tsx"],
      readFile: readFrom({
        "apps/web/components/office/new-mission-dialog.tsx": "<Dialog />",
        "apps/web/components/sources/instant-install.tsx":
          'fetch("/api/compose", { method: "POST" })',
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered).toEqual([
      "apps/web/components/sources/instant-install.tsx",
    ]);
  });

  it("passes a changed surface that is declared", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        composeSurface(["apps/web/components/office/new-mission-dialog.tsx"]),
      ]),
      changedFiles: ["apps/web/components/office/new-mission-dialog.tsx"],
      readFile: readFrom({
        "apps/web/components/office/new-mission-dialog.tsx":
          'fetch("/api/compose")',
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.covered).toEqual([
      "apps/web/components/office/new-mission-dialog.tsx",
    ]);
  });

  it("does not ask for a declaration when a surface file is deleted", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        composeSurface(["apps/web/components/office/new-mission-dialog.tsx"]),
      ]),
      changedFiles: ["apps/web/components/office/removed-dialog.tsx"],
      readFile: readFrom({
        "apps/web/components/office/new-mission-dialog.tsx": "<Dialog />",
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.uncovered).toEqual([]);
  });

  it("fails when a declared file no longer exists", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        composeSurface(["apps/web/components/office/removed-dialog.tsx"]),
      ]),
      changedFiles: [],
      readFile: readFrom({}),
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("does not exist");
  });

  it("accepts declared surfaces without a compose marker (name rule)", () => {
    const report = evaluateComposeGate({
      manifest: manifestWith([
        {
          id: "X-1",
          label: "Legacy manual form",
          files: ["apps/web/components/ops/legacy-policy-form.tsx"],
          status: "exempt",
          reason: "Safety control, not a configuration draft.",
        },
      ]),
      changedFiles: ["apps/web/components/ops/legacy-policy-form.tsx"],
      readFile: readFrom({
        "apps/web/components/ops/legacy-policy-form.tsx": "<form />",
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.covered).toEqual([
      "apps/web/components/ops/legacy-policy-form.tsx",
    ]);
  });
});

describe("manifest schema", () => {
  it("validates the checked-in manifest", () => {
    const raw = JSON.parse(
      readFileSync(path.join(repoRoot, MANIFEST_PATH), "utf8"),
    ) as unknown;
    const validation = validateManifest(raw);
    expect(validation.errors).toEqual([]);
    expect(validation.manifest?.surfaces.length).toBeGreaterThan(0);
  });

  it("covers every input surface in the repository", () => {
    const raw = JSON.parse(
      readFileSync(path.join(repoRoot, MANIFEST_PATH), "utf8"),
    ) as unknown;
    const files = collectWebSourceFiles(repoRoot);
    const report = evaluateComposeGate({
      manifest: raw,
      changedFiles: files,
      readFile: (file) => {
        const full = path.join(repoRoot, file);
        return existsSync(full) ? readFileSync(full, "utf8") : null;
      },
    });
    expect(report.uncovered).toEqual([]);
    // Every declared file exists (the staleness check), and every detected
    // candidate is declared. Undetected declarations are allowed: authors may
    // declare a surface that this narrow detector does not classify.
    expect(report.errors).toEqual([]);
  });

  it("matches the ComposeKind contract in the API route", () => {
    const route = readFileSync(
      path.join(repoRoot, "apps/web/app/api/compose/route.ts"),
      "utf8",
    );
    for (const kind of COMPOSE_KINDS) {
      expect(route).toContain(`value === "${kind}"`);
    }
  });

  it("rejects an unknown compose kind", () => {
    const validation = validateManifest(
      manifestWith([
        composeSurface(["apps/web/components/a/a-form.tsx"], ["nope"]),
      ]),
    );
    expect(validation.manifest).toBeNull();
    expect(validation.errors.join("\n")).toContain("unknown kind");
  });

  it("rejects a missing deterministic fallback or review step", () => {
    const surface = composeSurface(["apps/web/components/a/a-form.tsx"]);
    const noFallback = validateManifest(
      manifestWith([{ ...surface, fallback: "manual" }]),
    );
    expect(noFallback.errors.join("\n")).toContain(
      'fallback must be "heuristic"',
    );
    const noReview = validateManifest(
      manifestWith([{ ...surface, review: "free text" }]),
    );
    expect(noReview.errors.join("\n")).toContain("review must be");
  });

  it("requires a reason for exempt surfaces", () => {
    const validation = validateManifest(
      manifestWith([
        {
          id: "E-1",
          label: "Exempt",
          files: ["apps/web/components/a/a-form.tsx"],
          status: "exempt",
        },
      ]),
    );
    expect(validation.errors.join("\n")).toContain("reason is required");
  });

  it("rejects compose fields on exempt surfaces", () => {
    const validation = validateManifest(
      manifestWith([
        {
          id: "E-1",
          label: "Exempt",
          files: ["apps/web/components/a/a-form.tsx"],
          status: "exempt",
          reason: "Not a config surface.",
          composeKinds: ["mission"],
        },
      ]),
    );
    expect(validation.errors.join("\n")).toContain(
      "must not declare composeKinds",
    );
  });

  it("rejects duplicate ids and duplicate file ownership", () => {
    const duplicateId = validateManifest(
      manifestWith([
        composeSurface(["apps/web/components/a/a-form.tsx"]),
        { ...composeSurface(["apps/web/components/b/b-form.tsx"]), id: "T-1" },
      ]),
    );
    expect(duplicateId.errors.join("\n")).toContain("duplicated");

    const duplicateFile = validateManifest(
      manifestWith([
        composeSurface(["apps/web/components/a/a-form.tsx"]),
        {
          ...composeSurface(["apps/web/components/a/a-form.tsx"]),
          id: "T-2",
        },
      ]),
    );
    expect(duplicateFile.errors.join("\n")).toContain("already declared");
  });

  it("rejects globs, absolute paths and traversal", () => {
    for (const file of [
      "apps/web/components/*.tsx",
      "/etc/passwd",
      "../outside.tsx",
      "",
    ]) {
      const validation = validateManifest(
        manifestWith([composeSurface([file])]),
      );
      expect(validation.manifest).toBeNull();
    }
  });

  it("rejects an unsupported version and an empty surface list", () => {
    expect(
      validateManifest({ version: 2, surfaces: [] }).errors.join("\n"),
    ).toContain("version must be 1");
    expect(
      validateManifest({ version: 1, surfaces: [] }).errors.join("\n"),
    ).toContain("surfaces must be a non-empty array");
  });
});
