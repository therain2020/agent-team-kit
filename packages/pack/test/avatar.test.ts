import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_AVATAR } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { createPack, loadPack, updateAgent } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-avatar-"));
  roots.push(root);
  await createPack({
    root,
    dirName: "avatar-team",
    name: "Avatar Team",
    template: "minimal",
  });
  return path.join(root, "avatar-team");
}

function baseUpdate() {
  return {
    description: "Worker",
    model: "deepseek-flash",
    role: "builder" as const,
    tools: [] as string[],
    skills: [] as string[],
    instructions: "Do the work.",
  };
}

describe("agent avatar persistence", () => {
  it("writes a valid avatar and reloads it, staying under the 2KB budget", async () => {
    const dir = await makePack();
    const file = path.join(dir, "agents", "worker.md");
    const before = await readFile(file, "utf8");

    await updateAgent(dir, "worker", {
      ...baseUpdate(),
      avatar: DEFAULT_AVATAR,
    });

    const after = await readFile(file, "utf8");
    const growth =
      Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8");
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThanOrEqual(2048);

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.agents.get("worker")?.frontmatter.avatar).toEqual(
      DEFAULT_AVATAR,
    );
  });

  it("keeps an existing avatar when the update omits it", async () => {
    const dir = await makePack();
    const file = path.join(dir, "agents", "worker.md");
    await updateAgent(dir, "worker", {
      ...baseUpdate(),
      avatar: DEFAULT_AVATAR,
    });
    const withAvatar = await readFile(file, "utf8");

    await updateAgent(dir, "worker", {
      ...baseUpdate(),
      description: "Worker with a changed description",
    });

    const after = await readFile(file, "utf8");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.agents.get("worker")?.frontmatter.avatar).toEqual(
        DEFAULT_AVATAR,
      );
    }
    expect(after).toContain("changed description");
    expect(after.length).toBeGreaterThan(withAvatar.length);
  });

  it("removes the avatar when the update passes null", async () => {
    const dir = await makePack();
    await updateAgent(dir, "worker", {
      ...baseUpdate(),
      avatar: DEFAULT_AVATAR,
    });

    await updateAgent(dir, "worker", { ...baseUpdate(), avatar: null });

    const after = await readFile(path.join(dir, "agents", "worker.md"), "utf8");
    expect(after).not.toContain("avatar:");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.agents.get("worker")?.frontmatter.avatar).toBeUndefined();
    }
  });

  it("rejects an illegal avatar without writing a half-finished pack", async () => {
    const dir = await makePack();
    const file = path.join(dir, "agents", "worker.md");
    const before = await readFile(file, "utf8");

    // Palette has 7 colors; index 7 is out of range.
    await expect(
      updateAgent(dir, "worker", {
        ...baseUpdate(),
        avatar: { ...DEFAULT_AVATAR, pixels: "7".repeat(384) },
      }),
    ).rejects.toThrow(/invalid avatar/);

    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain("avatar:");
  });

  it("leaves old packs without an avatar unchanged", async () => {
    const dir = await makePack();
    const file = path.join(dir, "agents", "worker.md");

    const created = await readFile(file, "utf8");
    expect(created).not.toContain("avatar:");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.agents.get("worker")?.frontmatter.avatar).toBeUndefined();
    }

    // A later ordinary save still must not invent an avatar.
    await updateAgent(dir, "worker", baseUpdate());
    const after = await readFile(file, "utf8");
    expect(after).not.toContain("avatar:");
  });
});
