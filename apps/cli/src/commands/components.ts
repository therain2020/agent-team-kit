import { CliError } from "@kit/core";
import {
  type AssemblyLock,
  type ComponentKind,
  componentsRoot,
  listComponents,
  loadComponent,
  readAssemblyLock,
} from "@kit/workshop";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

const COMPONENT_KINDS: ComponentKind[] = [
  "agent",
  "workflow",
  "toolpack",
  "skillpack",
];

export function registerComponents(program: Command): void {
  const components = program
    .command("components")
    .description(
      "Local component library (agent / workflow / toolpack / skillpack)",
    );

  components
    .command("list")
    .description("List components in the local library")
    .option("--root <dir>", "components root (default: ./components)")
    .option(
      "--pack <dir>",
      "annotate bound state from a pack's components.lock.json",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { root?: string; pack?: string; json?: boolean }) => {
        const json = wantsJson(options);
        let lock: AssemblyLock | undefined;
        if (options.pack) {
          const read = await readAssemblyLock(options.pack);
          if (!read.ok) {
            emitError(
              json,
              new CliError("usage", "invalid components.lock.json", {
                details: read.issues,
              }),
            );
            return;
          }
          lock = read.lock;
        }

        const list = await listComponents(options.root, lock ? { lock } : {});
        emit(
          json,
          { root: componentsRoot(options.root), components: list },
          () => {
            if (list.length === 0) {
              console.log("no components found");
              return;
            }
            for (const component of list) {
              const mark = component.valid ? "✓" : "✖";
              const flags = [
                component.bound ? "bound" : undefined,
                component.version ?? undefined,
              ]
                .filter(Boolean)
                .join(" ");
              console.log(
                `${mark} ${component.kind}/${component.id}${flags ? ` (${flags})` : ""}`,
              );
              for (const issue of component.issues) {
                console.log(
                  `    ! ${issue.code} ${issue.path}: ${issue.message}`,
                );
              }
            }
          },
        );
      },
    );

  components
    .command("validate [kind] [id]")
    .description("Validate a single component, or the whole library")
    .option("--root <dir>", "components root (default: ./components)")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        kind: string | undefined,
        id: string | undefined,
        options: { root?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        if (kind !== undefined) {
          if (!isComponentKind(kind)) {
            emitError(
              json,
              new CliError("usage", `unknown component kind: ${kind}`, {
                hint: `expected one of ${COMPONENT_KINDS.join(", ")}`,
              }),
            );
            return;
          }
          if (!id) {
            emitError(
              json,
              new CliError(
                "usage",
                "pass both <kind> and <id> to validate one component",
              ),
            );
            return;
          }

          const result = await loadComponent(kind, id, options.root);
          if (!result.ok) {
            const issues = result.issues;
            if (json) {
              emitError(
                json,
                new CliError("usage", `${kind}/${id} is invalid`, {
                  details: issues,
                }),
              );
            } else {
              console.error(`✖ ${kind}/${id} is invalid`);
              for (const issue of issues) {
                console.error(
                  `  ! ${issue.code} ${issue.path}: ${issue.message}`,
                );
              }
              process.exitCode = 2;
            }
            return;
          }
          emit(json, result.component, () => {
            console.log(
              `✓ ${kind}/${id} (${result.component.version ?? "unversioned"}) ${result.component.sha256}`,
            );
          });
          return;
        }

        const list = await listComponents(options.root);
        const invalid = list.filter((component) => !component.valid);
        const report = {
          root: componentsRoot(options.root),
          total: list.length,
          invalid: invalid.length,
          components: list,
        };
        if (invalid.length > 0) {
          emitError(
            json,
            new CliError("usage", `${invalid.length} invalid component(s)`, {
              details: report,
            }),
          );
          if (!json) {
            for (const component of invalid) {
              console.error(`✖ ${component.kind}/${component.id}`);
              for (const issue of component.issues) {
                console.error(
                  `  ! ${issue.code} ${issue.path}: ${issue.message}`,
                );
              }
            }
          }
          return;
        }
        emit(json, report, () => {
          console.log(
            `✓ ${list.length} component(s) valid under ${report.root}`,
          );
        });
      },
    );
}

function isComponentKind(value: string): value is ComponentKind {
  return (COMPONENT_KINDS as string[]).includes(value);
}
