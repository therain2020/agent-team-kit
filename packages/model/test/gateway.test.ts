import { describe, expect, it } from "vitest";
import { StubModelGateway, loadModelConfig } from "../src/index";

describe("model gateway", () => {
  it("uses stub mode without an API key", () => {
    const config = loadModelConfig({});
    expect(config.mode).toBe("stub");
  });

  it("resolves model aliases", () => {
    const config = loadModelConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_MODEL_PRO: "deepseek-v4-pro-test",
    });
    expect(config.mode).toBe("live");
    expect(config.aliases["deepseek-pro"]).toBe("deepseek-v4-pro-test");
  });

  it("returns deterministic stub responses", async () => {
    const gateway = new StubModelGateway();
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: "test",
      input: "hello",
    });
    expect(response.text).toContain("[stub:deepseek-flash]");
    expect(response.usage.costCny).toBe(0);
  });
});
