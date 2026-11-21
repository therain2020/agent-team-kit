import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceProposal,
  evaluateSourceYield,
  fetchSource,
  installSourceProposal,
  listInstalledSources,
  listRetirementProposals,
  listSourceProposals,
  loadInstalledSource,
  retireSource,
  setSourceBudget,
  updateSourceDefinition,
} from "../src";

const roots: string[] = [];

const sourceYaml = `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: demo-feed
  version: 1.0.0
  description: Demo feed
spec:
  type: rss
  request:
    url: https://feeds.example.com/rss.xml
`;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-source-mfg-"));
  roots.push(root);
  return root;
}

function noEndpoint() {
  return async () => undefined;
}

async function installDemo(root: string): Promise<string> {
  const proposal = await createSourceProposal({
    intent: "fetch the demo feed",
    yaml: sourceYaml,
    root,
    keys: [],
    validateEndpoint: noEndpoint(),
  });
  const installed = await installSourceProposal({
    id: proposal.id,
    approved: true,
    actor: "observer",
    root,
    keys: [],
    validateEndpoint: noEndpoint(),
  });
  return installed.installed.definition.metadata.name;
}

describe("source manufacture: proposal → gate → install", () => {
  it("drafts, gates, refuses self-install and installs after approval", async () => {
    const root = await tempRoot();
    const proposal = await createSourceProposal({
      intent: "fetch the demo feed",
      yaml: sourceYaml,
      root,
      keys: [],
      validateEndpoint: noEndpoint(),
    });

    expect(proposal.status).toBe("validated");
    expect(proposal.issues).toEqual([]);
    expect(proposal.trust).toEqual({
      level: "community",
      signature: "missing",
    });
    expect(proposal.secretScan).toBe("passed");
    expect(proposal.risk.requiresApproval).toBe(true);
    expect(existsSync(path.join(root, "demo-feed.yaml"))).toBe(false);

    await expect(
      installSourceProposal({
        id: proposal.id,
        approved: false,
        root,
        keys: [],
        validateEndpoint: noEndpoint(),
      }),
    ).rejects.toThrow(/approval/);

    const installed = await installSourceProposal({
      id: proposal.id,
      approved: true,
      actor: "observer",
      root,
      keys: [],
      validateEndpoint: noEndpoint(),
    });
    expect(installed.installed.meta.repo).toBe("local/manufacture");
    expect(installed.installed.meta.secretScan).toBe("passed");
    expect(installed.installed.meta.manufacture?.proposalId).toBe(proposal.id);
    expect(installed.proposal.status).toBe("applied");
    expect(existsSync(path.join(root, "demo-feed.yaml"))).toBe(true);

    const listed = await listInstalledSources(root);
    expect(listed.map((entry) => entry.definition.metadata.name)).toEqual([
      "demo-feed",
    ]);
    const proposals = await listSourceProposals(root);
    expect(proposals[0]?.status).toBe("applied");
  });
});

describe("source manufacture: code adapters", () => {
  it("rejects a code-type adapter and routes it to the code gate", async () => {
    const root = await tempRoot();
    const codeYaml = `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: code-feed
  version: 0.1.0
spec:
  type: command
  request:
    url: https://feeds.example.com/rss.xml
`;
    const proposal = await createSourceProposal({
      intent: "run a custom scraper",
      yaml: codeYaml,
      root,
      keys: [],
      validateEndpoint: noEndpoint(),
    });
    expect(proposal.status).toBe("rejected");
    const issue = proposal.issues.find(
      (entry) => entry.code === "code_adapter_rejected",
    );
    expect(issue?.message).toMatch(/code gate/);

    await expect(
      installSourceProposal({
        id: proposal.id,
        approved: true,
        root,
        keys: [],
        validateEndpoint: noEndpoint(),
      }),
    ).rejects.toThrow(/blocking issues/);
    expect(existsSync(path.join(root, "code-feed.yaml"))).toBe(false);
  });

  it("rejects a declarative type that smuggles a command request", async () => {
    const root = await tempRoot();
    const proposal = await createSourceProposal({
      intent: "rss with a script",
      yaml: `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: script-feed
  version: 0.1.0
spec:
  type: rss
  request:
    url: https://feeds.example.com/rss.xml
    command: curl https://feeds.example.com
`,
      root,
      keys: [],
      checkEndpoint: false,
    });
    expect(proposal.status).toBe("rejected");
    expect(
      proposal.issues.some((entry) => entry.code === "code_adapter_rejected"),
    ).toBe(true);
  });
});

describe("source retirement keeps history", () => {
  it("proposes retirement on low yield and keeps manifest, meta and captures", async () => {
    const root = await tempRoot();
    const name = await installDemo(root);
    const health = {
      sourceId: name,
      runs: 6,
      successes: 6,
      failures: 0,
      itemsCollected: 30,
      eventsCreated: 1,
      consecutiveFailures: 0,
      degraded: false,
    };

    const verdict = evaluateSourceYield(health);
    expect(verdict.lowYield).toBe(true);
    expect(verdict.eventRatio).toBeCloseTo(1 / 30);

    const proposals = await listRetirementProposals({
      health: [health],
      root,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe(`retire-${name}`);
    expect(proposals[0]?.status).toBe("proposed");

    const retired = await retireSource({
      name,
      reason: "low yield",
      proposalId: proposals[0]?.id,
      evidence: { eventRatio: verdict.eventRatio, runs: 6 },
      actor: "observer",
      root,
    });
    expect(retired.meta.retiredAt).toBeTruthy();
    expect(retired.meta.retirement?.reason).toBe("low yield");

    // The manifest and meta record survive; only collection stops.
    expect(existsSync(path.join(root, `${name}.yaml`))).toBe(true);
    const meta = JSON.parse(
      await readFile(path.join(root, `${name}.meta.json`), "utf8"),
    ) as { retiredAt?: string };
    expect(meta.retiredAt).toBeTruthy();
    await expect(fetchSource(name, { root })).rejects.toThrow(/retired/);
    expect(
      await listRetirementProposals({ health: [health], root }),
    ).toHaveLength(0);

    const audit = await readFile(
      path.join(root, ".manufacture", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"action":"retired"');
    expect(audit).toContain("raw captures");
  });
});

describe("observer edit and budget", () => {
  it("edits through the gate and refuses a smuggling edit", async () => {
    const root = await tempRoot();
    const name = await installDemo(root);
    const edited = sourceYaml.replace("version: 1.0.0", "version: 1.1.0");
    const updated = await updateSourceDefinition({
      name,
      yaml: edited,
      root,
      keys: [],
      validateEndpoint: noEndpoint(),
    });
    expect(updated.definition.metadata.version).toBe("1.1.0");

    await expect(
      updateSourceDefinition({
        name,
        yaml: `apiVersion: agentteam/source/v1
kind: Source
metadata:
  name: demo-feed
  version: 1.2.0
spec:
  type: rss
  command: curl https://feeds.example.com/rss.xml
  request:
    url: https://feeds.example.com/rss.xml
`,
        root,
        keys: [],
        validateEndpoint: noEndpoint(),
      }),
    ).rejects.toThrow();
    const reloaded = await loadInstalledSource(name, root);
    expect(reloaded?.definition.metadata.version).toBe("1.1.0");
  });

  it("sets and persists a per-source budget", async () => {
    const root = await tempRoot();
    const name = await installDemo(root);
    const updated = await setSourceBudget({
      name,
      budget: { dailyCostCny: 2.5, maxItemsPerRun: 25 },
      actor: "observer",
      root,
    });
    expect(updated.meta.budget).toEqual({
      dailyCostCny: 2.5,
      maxItemsPerRun: 25,
    });
    const reloaded = await loadInstalledSource(name, root);
    expect(reloaded?.meta.budget).toEqual({
      dailyCostCny: 2.5,
      maxItemsPerRun: 25,
    });

    await expect(
      setSourceBudget({
        name,
        budget: { dailyCostCny: -1, maxItemsPerRun: 25 },
        root,
      }),
    ).rejects.toThrow(/non-negative/);
  });
});
