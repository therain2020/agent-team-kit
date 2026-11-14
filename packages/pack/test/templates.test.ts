import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getTemplatesRoot,
  listTemplates,
  loadTemplate,
} from "../src/templates";

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

  it("honours KIT_TEMPLATES_ROOT", () => {
    const previous = process.env.KIT_TEMPLATES_ROOT;
    const configured = path.join(os.tmpdir(), "kit-templates-root");
    process.env.KIT_TEMPLATES_ROOT = configured;
    try {
      expect(getTemplatesRoot()).toBe(path.resolve(configured));
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "KIT_TEMPLATES_ROOT");
      } else {
        process.env.KIT_TEMPLATES_ROOT = previous;
      }
    }
  });

  it("resolves templates relative to the package, not the cwd", () => {
    expect(getTemplatesRoot()).toBe(
      path.resolve(import.meta.dirname, "../../../templates"),
    );
  });
});
