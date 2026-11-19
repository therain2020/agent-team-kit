import path from "node:path";
import { CliError } from "@kit/core";
import { createPack, listTemplates } from "@kit/pack";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";
import { kitCommand } from "../repo";

export function registerInit(program: Command): void {
  program
    .command("init [dir]")
    .description("Create a Team Pack from a template")
    .option("--template <name>", "template id (see --list)", "minimal")
    .option("--list", "list available templates", false)
    .option("--name <name>", "team name")
    .option("--description <text>", "team description")
    .option("--manager <name>", "manager display name", "manager")
    .option("--manager-model <alias>", "manager model alias", "deepseek-pro")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        dir: string | undefined,
        options: {
          template: string;
          list: boolean;
          name?: string;
          description?: string;
          manager: string;
          managerModel: string;
          idempotencyKey?: string;
          json: boolean;
        },
      ) => {
        const json = wantsJson(options);
        const templates = await listTemplates();

        if (options.list) {
          if (templates.length === 0) {
            emitError(
              json,
              new CliError("not_found", "no templates found", {
                hint: "set KIT_TEMPLATES_ROOT or run from a kit checkout",
              }),
            );
            return;
          }
          emit(json, { templates }, () => {
            for (const template of templates) {
              console.log(
                `${template.id}\t${template.name}\t${template.description}`,
              );
            }
          });
          return;
        }

        if (!dir) {
          emitError(
            json,
            new CliError("usage", "missing target directory", {
              hint: "usage: kit init <dir> --template research · kit init --list",
            }),
          );
          return;
        }

        const templateId = options.template;
        if (!templates.some((item) => item.id === templateId)) {
          emitError(
            json,
            new CliError("usage", `unknown template: ${templateId}`, {
              hint:
                templates.length === 0
                  ? "no templates found — set KIT_TEMPLATES_ROOT or run from a kit checkout"
                  : `choose one of: ${templates.map((item) => item.id).join(", ")}`,
            }),
          );
          return;
        }

        const dirName = path.basename(path.resolve(dir));
        const root = path.dirname(path.resolve(dir));
        const name = options.name?.trim() || dirName;

        try {
          const result = await createPack({
            root,
            dirName,
            name,
            description: options.description,
            template: templateId,
            managerName: options.manager,
            managerModel: options.managerModel,
          });
          const created = path.relative(process.cwd(), result.dir) || ".";
          const command = kitCommand();
          emit(
            json,
            {
              dir: result.dir,
              relativeDir: created,
              template: templateId,
              name,
              manager: options.manager,
              managerModel: options.managerModel,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
            },
            () => {
              console.log(`✔ created ${result.dir}`);
              console.log(`  next: ${command} pack validate "${created}"`);
              console.log(`        ${command} pack simulate "${created}"`);
              console.log(
                `        ${command} up --web   # open /packs and run this team`,
              );
            },
          );
        } catch (error) {
          emitError(
            json,
            new CliError(
              "internal",
              `init failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      },
    );
}
