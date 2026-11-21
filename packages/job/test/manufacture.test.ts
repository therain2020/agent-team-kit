import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AssemblyLock,
  type ComponentRef,
  agentFrontmatterSchema,
  assemblyLockSchema,
  componentRefSchema,
  pipelineSpecSchema,
} from "@kit/core";
import {
  type ComponentLibrary,
  type LoadedPack,
  type ResolvedComponent,
  buildPackRun,
  createPack,
  loadPack,
} from "@kit/pack";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  MANUFACTURE_LOCK_FILE,
  ManufactureError,
  acceptManufacture,
  draftManufacture,
  dryRunManufacture,
  listManufactureProposals,
  readManufactureLock,
  rollbackManufacture,
  validateDraft,
} from "../src/manufacture";

const roots: string[] = [];
const env = { KIT_MODEL_MODE: "stub" };

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-manufacture-"));
  roots.push(root);
  await createPack({
    root,
    dirName: "team",
    name: "Manufacture Team",
    template: "minimal",
  });
  return path.join(root, "team");
}

async function loadOk(packDir: string): Promise<LoadedPack> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("; "));
  }
  return loaded;
}

describe("manufacture: agent end to end", () => {
  it("drafts, dry-runs, accepts and rolls back a new agent", async () => {
    const packDir = await makePack();

    const proposal = await draftManufacture({
      kind: "agent",
      intent: "审阅发布前的引用与数据",
      assetId: "reviewer",
      packDir,
      env,
    });
    expect(proposal.status).toBe("validated");
    expect(proposal.model).toBe("heuristic");
    expect(proposal.draft.type).toBe("agent");
    expect(proposal.issues).toEqual([]);
    // Drafting never touches the pack.
    expect(existsSync(path.join(packDir, "agents", "reviewer.md"))).toBe(false);

    const dryRun = await dryRunManufacture(packDir, proposal.id);
    expect(dryRun.dryRun?.ok).toBe(true);
    expect(dryRun.dryRun?.preview.map((file) => file.path)).toContain(
      "agents/reviewer.md",
    );
    expect(existsSync(path.join(packDir, "agents", "reviewer.md"))).toBe(false);

    const accepted = await acceptManufacture(packDir, {
      proposalId: proposal.id,
      actor: "test",
    });
    expect(accepted.status).toBe("accepted");
    expect(existsSync(path.join(packDir, "agents", "reviewer.md"))).toBe(true);
    const loaded = await loadOk(packDir);
    expect(loaded.agents.has("reviewer")).toBe(true);

    const lock = await readManufactureLock(packDir);
    expect(lock.assets).toHaveLength(1);
    expect(lock.assets[0]).toMatchObject({
      kind: "agent",
      id: "reviewer",
      version: "0.1.0",
    });
    expect(lock.assets[0]?.source.sha256).toMatch(/^[a-f0-9]{64}$/);

    const audit = await readFile(
      path.join(packDir, ".manufacture", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"action":"accepted"');

    const rolledBack = await rollbackManufacture(packDir, proposal.id);
    expect(rolledBack.status).toBe("rolled-back");
    expect(existsSync(path.join(packDir, "agents", "reviewer.md"))).toBe(false);
    const after = await loadOk(packDir);
    expect(after.agents.has("reviewer")).toBe(false);
    expect((await readManufactureLock(packDir)).assets).toHaveLength(0);
    expect(existsSync(path.join(packDir, MANUFACTURE_LOCK_FILE))).toBe(false);
  });

  it("requires approval when tools or network permissions expand", async () => {
    const packDir = await makePack();
    const proposal = await draftManufacture({
      kind: "agent",
      intent: "抓取网页并汇总",
      assetId: "fetcher",
      packDir,
      env,
      agentFields: {
        tools: ["http_fetch"],
        permissions: { filesystem: "readonly", network: "allow" },
      },
    });
    expect(proposal.issues).toEqual([]);
    expect(proposal.risk.requiresApproval).toBe(true);
    expect(proposal.risk.reasons.join(" ")).toContain("http_fetch");

    const dryRun = await dryRunManufacture(packDir, proposal.id);
    expect(dryRun.dryRun?.ok).toBe(true);

    await expect(
      acceptManufacture(packDir, { proposalId: proposal.id }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(existsSync(path.join(packDir, "agents", "fetcher.md"))).toBe(false);

    const accepted = await acceptManufacture(packDir, {
      proposalId: proposal.id,
      approved: true,
    });
    expect(accepted.status).toBe("accepted");
    expect(existsSync(path.join(packDir, "agents", "fetcher.md"))).toBe(true);
  });

  it("rejects invalid ids with a labelled issue", async () => {
    const packDir = await makePack();
    const proposal = await draftManufacture({
      kind: "agent",
      intent: "Bad id",
      assetId: "Not_A_Slug",
      packDir,
      env,
    });
    expect(proposal.status).toBe("rejected");
    expect(proposal.issues.map((issue) => issue.code)).toContain("invalid_id");
    await expect(
      dryRunManufacture(packDir, proposal.id),
    ).rejects.toBeInstanceOf(ManufactureError);
  });
});

describe("manufacture: workflow", () => {
  it("manufactures and adopts a runnable workflow", async () => {
    const packDir = await makePack();
    const proposal = await draftManufacture({
      kind: "workflow",
      intent: "先草拟再交付",
      assetId: "release-review",
      packDir,
      env,
    });
    expect(proposal.issues).toEqual([]);
    expect(proposal.draft.type).toBe("workflow");

    const dryRun = await dryRunManufacture(packDir, proposal.id);
    expect(dryRun.dryRun?.ok).toBe(true);

    const accepted = await acceptManufacture(packDir, {
      proposalId: proposal.id,
    });
    expect(accepted.status).toBe("accepted");

    const loaded = await loadOk(packDir);
    const workflow = loaded.workflows.find(
      (item) => item.id === "release-review",
    );
    expect(workflow).toBeDefined();
    // The adopted workflow is runnable: the runtime can build a run plan.
    const run = await buildPackRun(loaded, { workflow: "release-review" });
    expect(run.workflow.id).toBe("release-review");

    const lock = await readManufactureLock(packDir);
    expect(lock.assets[0]).toMatchObject({
      kind: "workflow",
      id: "release-review",
    });
  });
});

describe("manufacture: pipeline", () => {
  it("validates the spec and records provenance in the lockfile", async () => {
    const packDir = await makePack();
    const proposal = await draftManufacture({
      kind: "pipeline",
      intent: "接收任务、审阅、汇总",
      assetId: "intake-pipeline",
      packDir,
      env,
    });
    expect(proposal.issues).toEqual([]);
    expect(proposal.draft.type).toBe("pipeline");

    const dryRun = await dryRunManufacture(packDir, proposal.id);
    expect(dryRun.dryRun?.ok).toBe(true);

    await acceptManufacture(packDir, { proposalId: proposal.id });
    const file = path.join(packDir, "pipelines", "intake-pipeline.yaml");
    expect(existsSync(file)).toBe(true);
    const spec = pipelineSpecSchema.parse(parse(await readFile(file, "utf8")));
    expect(spec.id).toBe("intake-pipeline");
    expect(spec.graph.nodes.length).toBeGreaterThan(0);

    const lock = await readManufactureLock(packDir);
    expect(lock.assets[0]).toMatchObject({
      kind: "pipeline",
      id: "intake-pipeline",
    });
  });

  it("rejects a cyclic or multi-entry graph", async () => {
    const packDir = await makePack();
    const loaded = await loadOk(packDir);
    const issues = await validateDraft(packDir, loaded, {
      type: "pipeline",
      id: "bad-pipeline",
      spec: {
        apiVersion: "agentteam/v1",
        kind: "Pipeline",
        id: "bad-pipeline",
        version: "1.0",
        description: "",
        graph: {
          nodes: [
            {
              id: "a",
              type: "agent",
              inputs: [],
              outputs: [],
              description: "",
            },
            {
              id: "b",
              type: "agent",
              inputs: [],
              outputs: [],
              description: "",
            },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        },
        bindings: [],
        policies: [],
      },
    });
    expect(issues.map((issue) => issue.code)).toContain("schema_invalid");
  });
});

describe("manufacture: components", () => {
  it("rejects missing components and labels them", async () => {
    const packDir = await makePack();
    const proposal = await draftManufacture({
      kind: "component",
      intent: "装配一个不存在的成员",
      packDir,
      env,
      componentIds: [{ kind: "agent", id: "ghost" }],
      availableComponents: [],
    });
    expect(proposal.status).toBe("rejected");
    expect(proposal.issues.map((issue) => issue.code)).toContain(
      "missing_component",
    );
  });

  it("rolls back atomically when the lockfile write fails", async () => {
    const packDir = await makePack();
    const library = failingWriteLockLibrary(packDir);

    const proposal = await draftManufacture({
      kind: "component",
      intent: "装配 watcher",
      packDir,
      env,
      componentIds: [{ kind: "agent", id: "watcher" }],
      availableComponents: [{ kind: "agent", id: "watcher" }],
    });
    expect(proposal.issues).toEqual([]);

    const dryRun = await dryRunManufacture(packDir, proposal.id, { library });
    expect(dryRun.dryRun?.ok).toBe(true);

    await expect(
      acceptManufacture(packDir, { proposalId: proposal.id }, { library }),
    ).rejects.toMatchObject({ code: "assembly_failed" });
    expect(existsSync(path.join(packDir, "agents", "watcher.md"))).toBe(false);
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    const proposals = await listManufactureProposals(packDir);
    expect(proposals[0]?.status).toBe("rolled-back");
  });
});

function failingWriteLockLibrary(realPackDir: string): ComponentLibrary {
  const ref: ComponentRef = componentRefSchema.parse({
    kind: "agent",
    id: "watcher",
    version: "1.0.0",
    source: {
      repo: "local/watcher",
      commit: "a".repeat(40),
      ref: "local",
      sha256: "b".repeat(64),
    },
  });
  const data = agentFrontmatterSchema.parse({
    name: "watcher",
    description: "Watches a channel",
    model: "deepseek-flash",
    role: "builder",
    tools: [],
    skills: [],
    permissions: { filesystem: "readonly", network: "none" },
  });
  const component: ResolvedComponent = {
    kind: "agent",
    id: "watcher",
    version: "1.0.0",
    ref,
    spec: { kind: "agent", data },
    entryText:
      "---\nname: watcher\ndescription: Watches a channel\nmodel: deepseek-flash\nrole: builder\ntools: []\nskills: []\npermissions:\n  filesystem: readonly\n  network: none\n---\n\nWatch the channel.\n",
    files: [],
  };
  const emptyLock: AssemblyLock = assemblyLockSchema.parse({});

  return {
    async resolve(kind, id) {
      if (kind === "agent" && id === "watcher") {
        return { ok: true, component };
      }
      return {
        ok: false,
        issues: [
          {
            code: "component_not_found",
            path: ".",
            message: `component not found: ${kind}/${id}`,
          },
        ],
      };
    },
    async readLock() {
      return { ok: true, lock: emptyLock, issues: [] };
    },
    async writeLock(packDir) {
      // Dry-run targets a temp staging copy; only the live pack fails.
      if (path.resolve(packDir) === path.resolve(realPackDir)) {
        return {
          ok: false,
          issues: [
            {
              code: "lock_invalid",
              path: "components.lock.json",
              message: "simulated disk failure",
            },
          ],
        };
      }
      return { ok: true, issues: [] };
    },
  };
}
