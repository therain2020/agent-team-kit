import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { type TemplateDefinition, templateDefinitionSchema } from "@kit/core";
import { parse } from "yaml";

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  roles: TemplateDefinition["roles"];
  agents: Array<{
    id: string;
    description: string;
    model: string;
    role: string;
  }>;
}

export function getTemplatesRoot(root?: string): string {
  return path.resolve(
    root ??
      process.env.KIT_TEMPLATES_ROOT ??
      path.join(process.cwd(), "templates"),
  );
}

export async function listTemplates(root?: string): Promise<TemplateSummary[]> {
  const templatesRoot = getTemplatesRoot(root);
  if (!existsSync(templatesRoot)) {
    return [];
  }
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  const templates: TemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const template = await loadTemplate(entry.name, templatesRoot);
      templates.push(summarize(template));
    } catch {
      // invalid templates stay out of the picker; loadTemplate reports details
    }
  }
  return templates.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadTemplate(
  id: string,
  root?: string,
): Promise<TemplateDefinition> {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`invalid template id: ${id}`);
  }
  const templatesRoot = getTemplatesRoot(root);
  const dir = path.resolve(templatesRoot, id);
  if (!dir.startsWith(`${templatesRoot}${path.sep}`)) {
    throw new Error(`template escapes templates root: ${id}`);
  }
  const file = path.join(dir, "template.yaml");
  if (!existsSync(file)) {
    throw new Error(`template not found: ${id}`);
  }
  const raw = parse(await readFile(file, "utf8"));
  const parsed = templateDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  if (parsed.data.id !== id) {
    throw new Error(
      `template id mismatch: directory ${id}, file ${parsed.data.id}`,
    );
  }
  return parsed.data;
}

function summarize(template: TemplateDefinition): TemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    roles: template.roles,
    agents: template.agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      model: agent.model,
      role: agent.role,
    })),
  };
}
