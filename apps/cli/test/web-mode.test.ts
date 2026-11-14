import { describe, expect, it } from "vitest";
import { parseWebMode, resolveWebMode, webRunArgs } from "../src/web-mode";

describe("web mode", () => {
  it("selects production only for the production flag", () => {
    expect(resolveWebMode("production")).toBe("production");
    expect(resolveWebMode(" Production ")).toBe("production");
  });

  it("falls back to the dev server for unset or unknown values", () => {
    expect(resolveWebMode(undefined)).toBe("dev");
    expect(resolveWebMode("")).toBe("dev");
    expect(resolveWebMode("staging")).toBe("dev");
  });

  it("accepts explicit dev aliases and rejects other values", () => {
    expect(parseWebMode("dev")).toBe("dev");
    expect(parseWebMode("development")).toBe("dev");
    expect(parseWebMode("production")).toBe("production");
    expect(parseWebMode("preview")).toBeNull();
  });

  it("starts the built console in production and next dev otherwise", () => {
    expect(webRunArgs("production")).toEqual([
      "run",
      "--cwd",
      "apps/web",
      "start",
    ]);
    expect(webRunArgs("dev")).toEqual(["run", "--cwd", "apps/web", "dev"]);
  });
});
