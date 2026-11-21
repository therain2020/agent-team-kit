import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentFrontmatter,
  type AssemblyLock,
  type ComponentKind,
  type ComponentRef,
  agentFrontmatterSchema,
  assemblyLockSchema,
  componentRefSchema,
  skillPackSchema,
  toolPackSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  type AssemblyComponentSpec,
  AssemblyError,
  type ComponentLibrary,
  type ResolvedComponent,
  assembleComponents,
} from "../src/assemble";
import { loadPack } from "../src/load-pack";
import { buildPackRun } from "../src/pack-run";
import { createPack } from "../src/pack-studio";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-assemble-"));
  roots.push(root);
  await createPack({
    root,
    dirName: "minimal-team",
    name: "Minimal Team",
    template: "minimal",
  });
  return path.join(root, "minimal-team");
}

function makeRef(
  kind: ComponentKind,
  id: string,
  version: string,
  seed = "1",
): ComponentRef {
  const sha256 = createHash("sha256")
    .update(`${kind}/${id}@${version}:${seed}`)
    .digest("hex");
  return componentRefSchema.parse({
    kind,
    id,
    version,
    source: {
      repo: `local/${id}`,
      commit: sha256.slice(0, 40),
      ref: "local",
      sha256,
    },
  });
}

interface ComponentOptions {
  version?: string;
  seed?: string;
}

const WEATHER_TOOL = {
  name: "weather_lookup",
  description: "Look up the weather",
  risk: "network" as const,
  adapter: "http" as const,
  endpoint: "https://api.example.com/weather",
  method: "GET" as const,
  permissions: { network: true },
};

function agentComponent(
  id: string,
  options: ComponentOptions & {
    tools?: string[];
    skills?: string[];
    networkNone?: boolean;
  } = {},
): ResolvedComponent {
  const version = options.version ?? "1.0.0";
  const frontmatter = {
    name: id,
    description: `${id} agent`,
    model: "deepseek-flash",
    role: "builder",
    tools: options.tools ?? [],
    skills: options.skills ?? [],
    permissions: options.networkNone
      ? { filesystem: "readonly", network: "none" }
      : { filesystem: "readonly", network: "allow" },
  };
  const data = agentFrontmatterSchema.parse(frontmatter);
  const entryText = `---\n${stringify(frontmatter)}---\n\nAct as ${id}.\n`;
  return {
    kind: "agent",
    id,
    version,
    ref: makeRef("agent", id, version, options.seed),
    spec: { kind: "agent", data },
    entryText,
    files: [],
  };
}

function toolpackComponent(
  id: string,
  tools: unknown[],
  options: ComponentOptions = {},
): ResolvedComponent {
  const version = options.version ?? "1.0.0";
  const data = toolPackSchema.parse({
    apiVersion: "agentteam/v1",
    kind: "ToolPack",
    name: id,
    version: "1.0.0",
    tools,
  });
  return {
    kind: "toolpack",
    id,
    version,
    ref: makeRef("toolpack", id, version, options.seed),
    spec: { kind: "toolpack", data },
    entryText: stringify(data),
    files: [],
  };
}

function workflowComponent(
  id: string,
  stages: unknown[],
  options: ComponentOptions = {},
): ResolvedComponent {
  const version = options.version ?? "1.0.0";
  const data = workflowDefinitionSchema.parse({
    id,
    version: "1.0",
    trigger: { event: "task.received" },
    stages,
  });
  return {
    kind: "workflow",
    id,
    version,
    ref: makeRef("workflow", id, version, options.seed),
    spec: { kind: "workflow", data },
    entryText: stringify(data),
    files: [],
  };
}

function skillpackComponent(
  id: string,
  name: string,
  options: ComponentOptions = {},
): ResolvedComponent {
  const version = options.version ?? "1.0.0";
  const data = skillPackSchema.parse({
    apiVersion: "agentteam/v1",
    kind: "SkillPack",
    name,
    version: "1.0.0",
    entry: "SKILL.md",
    files: ["SKILL.md"],
  });
  const skill = `---\nname: ${name}\ndescription: skill\n---\n\nDo it.\n`;
  return {
    kind: "skillpack",
    id,
    version,
    ref: makeRef("skillpack", id, version, options.seed),
    spec: { kind: "skillpack", data },
    entryText: stringify(data),
    files: [{ path: "SKILL.md", content: skill }],
  };
}

function emptyLock(): AssemblyLock {
  return assemblyLockSchema.parse({});
}

function libraryFromFixtures(
  fixtures: Record<string, ResolvedComponent>,
): ComponentLibrary {
  return {
    async resolve(kind, id) {
      const component = fixtures[`${kind}/${id}`];
      if (!component) {
        return {
          ok: false,
          issues: [
            {
              code: "component_not_found",
              path: ".",
              message: `missing ${kind}/${id}`,
            },
          ],
        };
      }
      return { ok: true, component };
    },
    async readLock(packDir) {
      const file = path.join(packDir, "components.lock.json");
      if (!existsSync(file)) {
        return { ok: true, lock: emptyLock(), issues: [] };
      }
      const parsed = assemblyLockSchema.safeParse(
        parse(await readFile(file, "utf8")),
      );
      if (!parsed.success) {
        return {
          ok: false,
          lock: emptyLock(),
          issues: parsed.error.issues.map((issue) => ({
            code: "lock_invalid",
            path: "components.lock.json",
            message: issue.message,
          })),
        };
      }
      return { ok: true, lock: parsed.data, issues: [] };
    },
    async writeLock(packDir, lock) {
      const parsed = assemblyLockSchema.safeParse(lock);
      if (!parsed.success) {
        return {
          ok: false,
          issues: parsed.error.issues.map((issue) => ({
            code: "lock_invalid",
            path: "components.lock.json",
            message: issue.message,
          })),
        };
      }
      await writeFile(
        path.join(packDir, "components.lock.json"),
        `${JSON.stringify(parsed.data, null, 2)}\n`,
        "utf8",
      );
      return { ok: true, issues: [] };
    },
  };
}

function fixtureSpec(component: ResolvedComponent): AssemblyComponentSpec {
  return component.spec;
}

describe("component assembler", () => {
  it("binds toolpack + agent + workflow and the pack validates and runs", async () => {
    const packDir = await makePack();
    const weather = toolpackComponent("weather", [WEATHER_TOOL]);
    const analyst = agentComponent("analyst", { tools: ["weather_lookup"] });
    const review = workflowComponent("review", [
      {
        id: "analyze",
        type: "agent",
        agent: "analyst",
        inputs: ["task"],
        outputs: ["draft"],
      },
    ]);
    const library = libraryFromFixtures({
      "toolpack/weather": weather,
      "agent/analyst": analyst,
      "workflow/review": review,
    });

    const result = await assembleComponents(
      {
        packDir,
        components: [
          { kind: "toolpack", id: "weather" },
          { kind: "agent", id: "analyst" },
          { kind: "workflow", id: "review" },
        ],
      },
      library,
    );

    expect(result.noop).toBe(false);
    expect(result.bindings).toHaveLength(3);
    expect(fixtureSpec(analyst).kind).toBe("agent");

    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.agents.has("analyst")).toBe(true);
    expect(loaded.pack.workflows).toContain("workflows/review.yaml");

    const built = await buildPackRun(loaded, { workflow: "review" });
    const reviewStages = built.input.stages;
    expect(reviewStages.some((stage) => stage.agentId === "analyst")).toBe(
      true,
    );

    const lock = assemblyLockSchema.parse(
      parse(await readFile(path.join(packDir, "components.lock.json"), "utf8")),
    );
    expect(lock.components).toHaveLength(3);
    expect(lock.bindings).toHaveLength(3);
    expect(lock.bindings.map((binding) => binding.node).sort()).toEqual([
      "agent/analyst",
      "toolpack/weather",
      "workflow/review",
    ]);
  });

  it("previews a planned assembly without writing the pack", async () => {
    const packDir = await makePack();
    const analyst = agentComponent("analyst");
    const library = libraryFromFixtures({ "agent/analyst": analyst });
    const before = await readFile(path.join(packDir, "team.yaml"), "utf8");

    const preview = await assembleComponents(
      {
        packDir,
        components: [{ kind: "agent", id: "analyst" }],
        dryRun: true,
      },
      library,
    );

    expect(preview.preview).toBe(true);
    expect(preview.noop).toBe(false);
    expect(preview.bindings).toHaveLength(1);
    expect(preview.written).toContain("agents/analyst.md");
    expect(preview.lock.components).toHaveLength(1);
    expect(existsSync(path.join(packDir, "agents", "analyst.md"))).toBe(false);
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      before,
    );

    const applied = await assembleComponents(
      { packDir, components: [{ kind: "agent", id: "analyst" }] },
      library,
    );
    expect(applied.preview).toBeUndefined();
    expect(existsSync(path.join(packDir, "agents", "analyst.md"))).toBe(true);
  });

  it("binds a skillpack and lets an agent reference its skill", async () => {
    const packDir = await makePack();
    const writer = skillpackComponent("writer-pack", "writer");
    const scribe = agentComponent("scribe", { skills: ["writer"] });
    const library = libraryFromFixtures({
      "skillpack/writer-pack": writer,
      "agent/scribe": scribe,
    });

    await assembleComponents(
      {
        packDir,
        components: [
          { kind: "skillpack", id: "writer-pack" },
          { kind: "agent", id: "scribe" },
        ],
      },
      library,
    );

    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("; "));
    }
    expect(loaded.skills.get("writer")?.name).toBe("writer");
    expect(
      existsSync(path.join(packDir, "skillpacks", "writer-pack", "SKILL.md")),
    ).toBe(true);
  });

  it("rejects an unknown tool and leaves no partial writes", async () => {
    const packDir = await makePack();
    const before = await readFile(path.join(packDir, "team.yaml"), "utf8");
    const broken = agentComponent("broken", { tools: ["nope_tool"] });
    const library = libraryFromFixtures({ "agent/broken": broken });

    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "agent", id: "broken" }] },
        library,
      ),
    ).rejects.toBeInstanceOf(AssemblyError);

    expect(existsSync(path.join(packDir, "agents", "broken.md"))).toBe(false);
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      before,
    );
  });

  it("rejects a command tool without explicit consent", async () => {
    const packDir = await makePack();
    const shell = toolpackComponent("shell", [
      {
        name: "shell_run",
        description: "Run a command",
        risk: "execute",
        adapter: "command",
        command: ["echo", "hi"],
        permissions: { filesystem: "sandbox", network: false },
      },
    ]);
    const library = libraryFromFixtures({ "toolpack/shell": shell });

    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "toolpack", id: "shell" }] },
        library,
      ),
    ).rejects.toMatchObject({ name: "AssemblyError" });

    expect(existsSync(path.join(packDir, "toolpacks", "shell.yaml"))).toBe(
      false,
    );
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
  });

  it("rejects a permission conflict between a network tool and a sandboxed agent", async () => {
    const packDir = await makePack();
    const weather = toolpackComponent("weather", [WEATHER_TOOL]);
    const netless = agentComponent("netless", {
      tools: ["weather_lookup"],
      networkNone: true,
    });
    const library = libraryFromFixtures({
      "toolpack/weather": weather,
      "agent/netless": netless,
    });

    await expect(
      assembleComponents(
        {
          packDir,
          components: [
            { kind: "toolpack", id: "weather" },
            { kind: "agent", id: "netless" },
          ],
        },
        library,
      ),
    ).rejects.toThrow(/permissions.network: none/);
  });

  it("rejects a workflow that references an unknown agent without writing", async () => {
    const packDir = await makePack();
    const before = await readFile(path.join(packDir, "team.yaml"), "utf8");
    const ghostFlow = workflowComponent("ghost-flow", [
      {
        id: "run",
        type: "agent",
        agent: "ghost",
        inputs: ["task"],
        outputs: ["result"],
      },
    ]);
    const library = libraryFromFixtures({ "workflow/ghost-flow": ghostFlow });

    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "workflow", id: "ghost-flow" }] },
        library,
      ),
    ).rejects.toThrow(/unknown agent: ghost/);

    expect(existsSync(path.join(packDir, "workflows", "ghost-flow.yaml"))).toBe(
      false,
    );
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      before,
    );
  });

  it("rolls back a workflow the pack rejects (forward stage reference)", async () => {
    const packDir = await makePack();
    const before = await readFile(path.join(packDir, "team.yaml"), "utf8");
    const brokenFlow = workflowComponent("broken-flow", [
      {
        id: "second",
        type: "agent",
        agent: "worker",
        inputs: ["task"],
        outputs: ["x"],
        inputFrom: "first",
      },
      {
        id: "first",
        type: "agent",
        agent: "worker",
        inputs: ["task"],
        outputs: ["y"],
      },
    ]);
    const library = libraryFromFixtures({ "workflow/broken-flow": brokenFlow });

    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "workflow", id: "broken-flow" }] },
        library,
      ),
    ).rejects.toBeInstanceOf(AssemblyError);

    expect(
      existsSync(path.join(packDir, "workflows", "broken-flow.yaml")),
    ).toBe(false);
    expect(existsSync(path.join(packDir, "components.lock.json"))).toBe(false);
    expect(await readFile(path.join(packDir, "team.yaml"), "utf8")).toBe(
      before,
    );
  });

  it("is idempotent when the same assembly is applied twice", async () => {
    const packDir = await makePack();
    const weather = toolpackComponent("weather", [WEATHER_TOOL]);
    const analyst = agentComponent("analyst", { tools: ["weather_lookup"] });
    const library = libraryFromFixtures({
      "toolpack/weather": weather,
      "agent/analyst": analyst,
    });
    const request = {
      packDir,
      components: [
        { kind: "toolpack" as const, id: "weather" },
        { kind: "agent" as const, id: "analyst" },
      ],
    };

    const first = await assembleComponents(request, library);
    expect(first.noop).toBe(false);
    const second = await assembleComponents(request, library);
    expect(second.noop).toBe(true);

    const lock = assemblyLockSchema.parse(
      parse(await readFile(path.join(packDir, "components.lock.json"), "utf8")),
    );
    expect(lock.components).toHaveLength(2);
    expect(lock.bindings).toHaveLength(2);

    const team = parse(
      await readFile(path.join(packDir, "team.yaml"), "utf8"),
    ) as {
      agents: Array<{ id: string }>;
    };
    expect(team.agents.filter((agent) => agent.id === "analyst")).toHaveLength(
      1,
    );
  });

  it("rejects binding a different version of an already-locked component", async () => {
    const packDir = await makePack();
    const first = agentComponent("analyst", { seed: "1" });
    await assembleComponents(
      { packDir, components: [{ kind: "agent", id: "analyst" }] },
      libraryFromFixtures({ "agent/analyst": first }),
    );

    const second = agentComponent("analyst", { version: "2.0.0", seed: "2" });
    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "agent", id: "analyst" }] },
        libraryFromFixtures({ "agent/analyst": second }),
      ),
    ).rejects.toThrow(/version conflict|is locked at/);
  });

  it("rejects binding a manager agent as a component", async () => {
    const packDir = await makePack();
    const manager: ResolvedComponent = {
      kind: "agent",
      id: "boss",
      version: "1.0.0",
      ref: makeRef("agent", "boss", "1.0.0"),
      spec: {
        kind: "agent",
        data: {
          name: "boss",
          description: "Boss",
          model: "deepseek-pro",
          role: "manager",
          tools: [],
          skills: [],
        } satisfies AgentFrontmatter,
      },
      entryText: "---\nname: boss\n---\n\nBoss.\n",
      files: [],
    };
    await expect(
      assembleComponents(
        { packDir, components: [{ kind: "agent", id: "boss" }] },
        libraryFromFixtures({ "agent/boss": manager }),
      ),
    ).rejects.toThrow(/manager agents are pack-level/);
  });
});
