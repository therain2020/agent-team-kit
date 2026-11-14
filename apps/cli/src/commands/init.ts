import path from "node:path";
import { createPack, listTemplates } from "@kit/pack";
import type { Command } from "commander";

export function registerInit(program: Command): void {
  program
    .command("init <dir>")
    .description("Create a Team Pack from a template")
    .option("--template <name>", "template id (see --list)", "minimal")
    .option("--list", "list available templates", false)
    .option("--name <name>", "team name")
    .option("--description <text>", "team description")
    .option("--manager <name>", "manager display name", "manager")
    .option("--manager-model <alias>", "manager model alias", "deepseek-pro")
    .action(
      async (
        dir: string,
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
          for (const template of templates) {
            console.log(`${template.id}\t${template.name}`);
          }
          return;
        }
        const template = options.template;
        if (!templates.some((item) => item.id === template)) {
          console.error(`✖ unknown template: ${options.template}`);
          console.error(
            `  choose one of: ${templates.map((item) => item.id).join(", ")}`,
          );
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
            template,
            managerName: options.manager,
            managerModel: options.managerModel,
          });
          console.log(`✔ created ${result.dir}`);
          console.log(
            `  next: bun run kit pack validate packs/${result.dirName}`,
          );
          console.log(
            `        bun run kit pack simulate packs/${result.dirName}`,
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
