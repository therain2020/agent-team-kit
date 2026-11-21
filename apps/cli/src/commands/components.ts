import { CliError } from "@kit/core";
import {
  AssemblyError,
  type ComponentRequest,
  assembleComponents,
} from "@kit/pack";
import {
  type AssemblyLock,
  type ComponentKind,
  componentsRoot,
  installWorkshop,
  listComponents,
  loadComponent,
  previewWorkshop,
  readAssemblyLock,
  workshopComponentLibrary,
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

  components
    .command("install <repo>")
    .description(
      "Acquire an agent/workflow/toolpack/skillpack from the workshop into the component library",
    )
    .option("--root <dir>", "components root (default: ./components)")
    .option("--ref <ref>", "commit or branch")
    .option("--overwrite", "replace an existing component", false)
    .option("--yes", "accept third-party content", false)
    .option(
      "--accept-unsigned",
      "install items without a verified signature",
      false,
    )
    .option("--allow-code", "allow items with executable code", false)
    .option(
      "--accept-risk",
      "accept high-risk permissions (network/code)",
      false,
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        repo: string,
        options: {
          root?: string;
          ref?: string;
          overwrite?: boolean;
          yes: boolean;
          acceptUnsigned: boolean;
          allowCode: boolean;
          acceptRisk: boolean;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        if (!options.yes) {
          emitError(
            json,
            new CliError(
              "needs_confirmation",
              "pass --yes to accept third-party workshop content",
            ),
          );
          return;
        }
        try {
          const preview = await previewWorkshop({
            repo,
            ref: options.ref,
            token: process.env.GITHUB_TOKEN,
          });
          const kind = preview.manifest.kind;
          if (!isComponentKind(kind)) {
            emitError(
              json,
              new CliError(
                "usage",
                `${repo} is a ${kind} item, not a component`,
                {
                  hint: "use `kit workshop install` for pack, pipeline, source and template items",
                },
              ),
            );
            return;
          }

          const installed = await installWorkshop({
            repo,
            ref: preview.commit,
            componentsRoot: options.root,
            overwrite: options.overwrite === true,
            acceptThirdParty: true,
            acceptUnsigned: options.acceptUnsigned,
            allowCode: options.allowCode,
            acceptHighRisk: options.acceptRisk,
            token: process.env.GITHUB_TOKEN,
          });
          const loaded = await loadComponent(
            kind,
            installed.manifest.id,
            options.root,
          );
          if (!loaded.ok) {
            emitError(
              json,
              new CliError(
                "usage",
                `${kind}/${preview.manifest.id} is invalid`,
                { details: loaded.issues },
              ),
            );
            return;
          }
          emit(
            json,
            { ...installed, component: loaded.component },
            () => {
              console.log(
                `✓ ${kind}/${loaded.component.id} (${loaded.component.version ?? "unversioned"}) → ${installed.dir}`,
              );
            },
          );
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  components
    .command("assemble")
    .description(
      "Bind library components into a pack (staged writes + components.lock.json)",
    )
    .requiredOption("--pack <dir>", "target pack directory")
    .option(
      "--component <kind:id>",
      "component to bind, e.g. agent:researcher (repeatable)",
      collectValues,
      [],
    )
    .option("--root <dir>", "components root (default: ./components)")
    .option("--allow-command", "allow command-adapter tools", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        pack: string;
        component: string[];
        root?: string;
        allowCommand?: boolean;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const requests: ComponentRequest[] = [];
        for (const raw of options.component) {
          const [kind, id, ...rest] = raw.split(":");
          if (rest.length > 0 || !kind || !id || !isComponentKind(kind)) {
            emitError(
              json,
              new CliError("usage", `invalid --component: ${raw}`, {
                hint: "expected <kind>:<id>, kind is agent|workflow|toolpack|skillpack",
              }),
            );
            return;
          }
          requests.push({ kind, id });
        }
        if (requests.length === 0) {
          emitError(
            json,
            new CliError("usage", "pass at least one --component <kind:id>"),
          );
          return;
        }

        try {
          const result = await assembleComponents(
            {
              packDir: options.pack,
              components: requests,
              allowCommand: options.allowCommand === true,
            },
            workshopComponentLibrary(options.root),
          );
          emit(json, result, () => {
            if (result.noop) {
              console.log("✓ components already assembled (no changes)");
            } else {
              console.log(
                `✓ assembled ${result.bindings.length} component(s) into ${result.packDir}`,
              );
              for (const written of result.written) {
                console.log(`  + ${written}`);
              }
            }
            for (const warning of result.warnings) {
              console.log(`  ! ${warning}`);
            }
          });
        } catch (error) {
          if (error instanceof AssemblyError) {
            emitError(
              json,
              new CliError("usage", error.message, {
                details: { issues: error.issues, warnings: error.warnings },
              }),
            );
            if (!json) {
              for (const issue of error.issues) {
                console.error(
                  `  ! ${issue.code} ${issue.path}: ${issue.message}`,
                );
              }
            }
            return;
          }
          throw error;
        }
      },
    );
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isComponentKind(value: string): value is ComponentKind {
  return (COMPONENT_KINDS as string[]).includes(value);
}
