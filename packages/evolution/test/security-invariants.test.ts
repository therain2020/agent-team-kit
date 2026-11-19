import type { Dirent } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SECURITY_INVARIANTS,
  SecurityInvariantError,
  assertAgentWriteAllowed,
  assertFrozenSnapshotIntact,
  assertSnapshotRootAllowed,
  classifyProtectedWrite,
  describeRecoverySurface,
  detectControlPlaneDisable,
  evaluatePatchSecurity,
  isModeReadOnly,
  isWindowsPlatform,
  isWritable,
  runsAsRoot,
} from "../src/security-invariants";
import { createEvalSnapshot, verifyEvalSnapshot } from "../src/snapshot";

/**
 * Security invariant matrix for the evolution plane (70 §3.3/§5, 85 §3.6,
 * 50 §3.8). Every assertion carries its invariant id so a failure names the
 * rule it protects. All roots are temp dirs; the real KIT_HOME is never read
 * or written.
 */

const roots: string[] = [];

afterEach(async () => {
  const dirs = roots.splice(0);
  for (const root of dirs) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(prefix = "kit-invariants-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeWritable(root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeWritable(full);
    } else {
      await chmod(full, 0o666).catch(() => undefined);
    }
  }
}

async function makePack(root: string): Promise<string> {
  const packDir = path.join(root, "pack");
  await mkdir(path.join(packDir, "evals"), { recursive: true });
  await mkdir(path.join(packDir, "fixtures"), { recursive: true });
  await writeFile(
    path.join(packDir, "evals", "rubrics.yaml"),
    "version: 1\nrubrics:\n  radar:\n    dimensions: {}\n",
    "utf8",
  );
  await writeFile(path.join(packDir, "fixtures", "case.json"), "{}\n", "utf8");
  return packDir;
}

function expectInvariant(error: unknown, invariant: string): void {
  expect(error).toBeInstanceOf(SecurityInvariantError);
  expect((error as SecurityInvariantError).invariant).toBe(invariant);
  expect((error as SecurityInvariantError).code).toBe("security-invariant");
}

describe("security invariant matrix", () => {
  it("defines one id per invariant", () => {
    expect(Object.keys(SECURITY_INVARIANTS).sort()).toEqual([
      "SEC-INV-01",
      "SEC-INV-02",
      "SEC-INV-03",
      "SEC-INV-04",
    ]);
  });
});

describe("SEC-INV-01: recovery kernel / LKG / audit sink are not agent-writable", () => {
  it("rejects writes to the kernel, audit sink, LKG state and kill switch", async () => {
    const root = await tempRoot();
    const kitHome = path.join(root, "kit-home");
    const surface = describeRecoverySurface(kitHome);

    const targets = [
      path.join(surface.kernelDir, "kitd.ps1"),
      path.join(surface.kernelDir, "install-kitd.ps1"),
      path.join(surface.auditDir, "kitd.jsonl"),
      path.join(surface.stateDir, "lkg.txt"),
      path.join(surface.stateDir, "lkg-20260101.bundle"),
      surface.killFile,
    ];

    for (const target of targets) {
      const verdict = classifyProtectedWrite(target, { kitHome });
      expect(verdict.allowed, target).toBe(false);
      expect(verdict.invariant, target).toBe("SEC-INV-01");
      let error: unknown;
      try {
        assertAgentWriteAllowed(target, { kitHome });
      } catch (caught) {
        error = caught;
      }
      expectInvariant(error, "SEC-INV-01");
    }
  });

  it("allows ordinary repository and unrelated paths", async () => {
    const root = await tempRoot();
    const kitHome = path.join(root, "kit-home");
    for (const target of [
      path.join(root, "repo", "packages", "evolution", "src", "x.ts"),
      path.join(root, "scratch", "notes.md"),
    ]) {
      const verdict = assertAgentWriteAllowed(target, { kitHome });
      expect(verdict.allowed).toBe(true);
      expect(verdict.invariant).toBeNull();
    }
  });

  it("matches protected paths case-insensitively on Windows", async () => {
    if (!isWindowsPlatform()) {
      // POSIX paths are case-sensitive: SEC-INV-01 is an exact-prefix check.
      return;
    }
    const root = await tempRoot();
    const kitHome = path.join(root, "kit-home");
    const surface = describeRecoverySurface(kitHome);
    const verdict = classifyProtectedWrite(surface.auditDir.toUpperCase(), {
      kitHome,
    });
    expect(verdict.invariant).toBe("SEC-INV-01");
  });

  it("blocks agent patches that target absolute or escaping paths", () => {
    const windowsTarget =
      "C:\\Users\\operator\\.agent-team-kit\\audit\\kitd.jsonl";
    const posixTarget = "/home/operator/.agent-team-kit/bin/kitd.ps1";
    for (const file of [windowsTarget, posixTarget, "../../etc/audit.jsonl"]) {
      const decision = evaluatePatchSecurity({ files: [file] });
      expect(decision.action, file).toBe("block");
      expect(decision.invariant, file).toBe("SEC-INV-01");
      expect(decision.protectedTargets.length).toBeGreaterThan(0);
    }
  });
});

describe("SEC-INV-02: disabling audit or approval is blocked", () => {
  it("detects config and flag forms that turn the control plane off", () => {
    const samples = [
      "const auditEnabled = false;",
      '{"audit": false}',
      "KIT_AUDIT_ENABLED=0",
      "kit up --no-audit",
      "const config = { requireApproval: false };",
      "const approvalsEnabled = false;",
      "function skipApproval() {}",
      "kit apply --no-approval",
    ];
    for (const content of samples) {
      expect(
        detectControlPlaneDisable(content).length,
        content,
      ).toBeGreaterThan(0);
      const decision = evaluatePatchSecurity({
        files: ["packages/evolution/src/example.ts"],
        contents: { "packages/evolution/src/example.ts": content },
      });
      expect(decision.action, content).toBe("block");
      expect(decision.invariant, content).toBe("SEC-INV-02");
    }
  });

  it("does not flag audit/approval staying enabled", () => {
    const content = [
      "const auditEnabled = true;",
      "const requireApproval = true;",
      "// approval: required before publish",
    ].join("\n");
    expect(detectControlPlaneDisable(content)).toEqual([]);
    const decision = evaluatePatchSecurity({
      files: ["packages/evolution/src/example.ts"],
      contents: { "packages/evolution/src/example.ts": content },
    });
    expect(decision.action).toBe("allow");
    expect(decision.invariant).toBeNull();
  });

  it("blocks deleting audit or approval implementation and tests", () => {
    const decision = evaluatePatchSecurity({
      files: ["docs/evolution-governance.md"],
      deletedFiles: [
        "packages/store/src/audit-service.ts",
        "packages/store/src/approval-service.ts",
        "packages/store/test/approvals.test.ts",
      ],
    });
    expect(decision.action).toBe("block");
    expect(decision.invariant).toBe("SEC-INV-02");
    expect(decision.reasons.join("\n")).toMatch(/deleting audit\/approval/);
  });

  it("allows deleting an unrelated doc", () => {
    const decision = evaluatePatchSecurity({
      files: ["docs/evolution-governance.md"],
      deletedFiles: ["docs/old-notes.md"],
    });
    expect(decision.action).toBe("allow");
  });
});

describe("SEC-INV-03: eval snapshots live only in the external kit home", () => {
  it("creates a snapshot inside the kit home", async () => {
    const root = await tempRoot();
    const packDir = await makePack(root);
    const kitHome = path.join(root, "kit-home");
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_inside",
      packDir,
      cyclesRoot: path.join(kitHome, "cycles"),
      kitHome,
      freeze: false,
    });
    expect(snapshot.dir).toBe(
      path.join(kitHome, "cycles", "cyc_inside", "eval"),
    );
    expect((await verifyEvalSnapshot(snapshot.dir)).ok).toBe(true);
  });

  it("rejects a snapshot root outside the kit home", async () => {
    const root = await tempRoot();
    const packDir = await makePack(root);
    const kitHome = path.join(root, "kit-home");
    let error: unknown;
    try {
      await createEvalSnapshot({
        cycleId: "cyc_outside",
        packDir,
        cyclesRoot: path.join(root, "elsewhere", "cycles"),
        kitHome,
        freeze: false,
      });
    } catch (caught) {
      error = caught;
    }
    expectInvariant(error, "SEC-INV-03");
  });

  it("rejects a snapshot root inside the repository", async () => {
    const root = await tempRoot();
    const kitHome = path.join(root, "kit-home");
    let error: unknown;
    try {
      assertSnapshotRootAllowed({
        cyclesRoot: path.join(root, "repo", "cycles"),
        kitHome,
        repoRoot: path.join(root, "repo"),
      });
    } catch (caught) {
      error = caught;
    }
    expectInvariant(error, "SEC-INV-03");
  });

  it("rejects agent writes into the frozen snapshot root", async () => {
    const root = await tempRoot();
    const kitHome = path.join(root, "kit-home");
    const surface = describeRecoverySurface(kitHome);
    let error: unknown;
    try {
      assertAgentWriteAllowed(
        path.join(surface.cyclesRoot, "cyc_x", "eval", "manifest.json"),
        { kitHome },
      );
    } catch (caught) {
      error = caught;
    }
    expectInvariant(error, "SEC-INV-03");
  });
});

describe("SEC-INV-04: frozen snapshots fail closed when tampered", () => {
  it("marks frozen files read-only (Windows read-only attribute / POSIX 0444)", async () => {
    const root = await tempRoot();
    const packDir = await makePack(root);
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_frozen",
      packDir,
      cyclesRoot: path.join(root, "cycles"),
    });
    const frozen = path.join(snapshot.dir, "evals", "rubrics.yaml");

    expect(await isModeReadOnly(frozen)).toBe(true);
    // Root ignores POSIX modes; the hash guard below still applies.
    if (!runsAsRoot()) {
      expect(await isWritable(frozen)).toBe(false);
    }
    const info = await stat(frozen);
    expect(info.mode & 0o200).toBe(0);
  });

  it("fails verification after content or manifest tampering", async () => {
    const root = await tempRoot();
    const packDir = await makePack(root);
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_tamper",
      packDir,
      cyclesRoot: path.join(root, "cycles"),
      freeze: false,
    });

    await writeFile(
      path.join(snapshot.dir, "evals", "rubrics.yaml"),
      "tampered\n",
      "utf8",
    );
    let verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContain("evals/rubrics.yaml");
    let error: unknown;
    try {
      assertFrozenSnapshotIntact(verification, snapshot.dir);
    } catch (caught) {
      error = caught;
    }
    expectInvariant(error, "SEC-INV-04");

    await writeFile(
      path.join(snapshot.dir, "manifest.sha256"),
      `${"0".repeat(64)}\n`,
      "utf8",
    );
    verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContain("manifest.sha256");
    error = undefined;
    try {
      assertFrozenSnapshotIntact(verification, snapshot.dir);
    } catch (caught) {
      error = caught;
    }
    expectInvariant(error, "SEC-INV-04");
  });

  it("accepts an intact snapshot", async () => {
    const root = await tempRoot();
    const packDir = await makePack(root);
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_ok",
      packDir,
      cyclesRoot: path.join(root, "cycles"),
      freeze: false,
    });
    const verification = await verifyEvalSnapshot(snapshot.dir);
    expect(() =>
      assertFrozenSnapshotIntact(verification, snapshot.dir),
    ).not.toThrow();
  });
});
