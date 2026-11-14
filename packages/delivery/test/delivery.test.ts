import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverArtifact } from "../src/index";

describe("delivery", () => {
  it("skips external delivery in DRY_RUN", async () => {
    const result = await deliverArtifact({
      channel: "email",
      runId: "run_1",
      artifactId: "art_1",
      title: "Weekly brief",
      markdown: "# hello",
      runMode: "DRY_RUN",
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("writes local outbox files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "kit-delivery-"));
    try {
      const result = await deliverArtifact({
        channel: "local_file",
        runId: "run_1",
        artifactId: "art_1",
        title: "Weekly brief",
        markdown: "# hello",
        runMode: "LIVE",
        env: { KIT_HOME: home },
      });

      expect(result.ok).toBe(true);
      const text = await readFile(
        path.join(home, "outbox", "run_1", "art_1.md"),
        "utf8",
      );
      expect(text).toContain("Weekly brief");
      expect(text).toContain("# hello");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports missing SMTP configuration", async () => {
    const result = await deliverArtifact({
      channel: "email",
      runId: "run_1",
      artifactId: "art_1",
      title: "Weekly brief",
      markdown: "# hello",
      runMode: "LIVE",
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("KIT_SMTP_HOST");
  });
});
