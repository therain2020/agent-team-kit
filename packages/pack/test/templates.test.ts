import { describe, expect, it } from "vitest";
import { listTemplates, loadTemplate } from "../src/templates";

describe("template registry", () => {
  it("lists the built-in templates from data", async () => {
    const templates = await listTemplates();
    const ids = templates.map((template) => template.id);
    expect(ids).toEqual(
      expect.arrayContaining(["minimal", "research", "content", "product"]),
    );
  });

  it("loads the product template with role rules", async () => {
    const template = await loadTemplate("product");
    expect(template.roles.requireSeller).toBe(true);
    expect(template.roles.allowCombined).toBe(false);
    expect(template.workflow.id).toBe("product-cycle");
  });

  it("keeps workflow refs inside the template agent set", async () => {
    for (const summary of await listTemplates()) {
      const template = await loadTemplate(summary.id);
      const ids = new Set(["manager", ...template.agents.map((a) => a.id)]);
      for (const stage of template.workflow.stages) {
        if (stage.agent) {
          expect(ids.has(stage.agent), `${summary.id}: ${stage.agent}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("rejects unknown or escaping template ids", async () => {
    await expect(loadTemplate("missing")).rejects.toThrow();
    await expect(loadTemplate("../research")).rejects.toThrow();
  });
});
