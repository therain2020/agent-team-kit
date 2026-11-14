import path from "node:path";
import { createPack, listTemplates } from "@kit/pack";
import type { Command } from "commander";
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
        },
      ) => {
        const templates = await listTemplates();

        if (options.list) {
          if (templates.length === 0) {
            console.error("✖ no templates found");
            console.error(
              "  set KIT_TEMPLATES_ROOT or run from a kit checkout",
            );
            process.exitCode = 1;
            return;
          }
          for (const template of templates) {
            console.log(
              `${template.id}\t${template.name}\t${template.description}`,
            );
          }
          return;
        }

        if (!dir) {
          console.error("✖ missing target directory");
          console.error("  usage: kit init <dir> --template research");
          console.error("         kit init --list");
          process.exitCode = 1;
          return;
        }

        const templateId = options.template;
        if (!templates.some((item) => item.id === templateId)) {
          console.error(`✖ unknown template: ${templateId}`);
          if (templates.length === 0) {
            console.error(
              "  no templates found — set KIT_TEMPLATES_ROOT or run from a kit checkout",
            );
          } else {
            console.error(
              `  choose one of: ${templates.map((item) => item.id).join(", ")}`,
            );
          }
          process.exitCode = 1;
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
          console.log(`✔ created ${result.dir}`);
          console.log(`  next: ${command} pack validate "${created}"`);
          console.log(`        ${command} pack simulate "${created}"`);
          console.log(
            `        ${command} up --web   # open /packs and run this team`,
          );
        } catch (error) {
          console.error(
            `✖ init failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}
