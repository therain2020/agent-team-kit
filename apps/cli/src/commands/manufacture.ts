import {
  MANUFACTURE_KINDS,
  type ManufactureAssetKind,
  type ManufactureComponentRequest,
  acceptManufacture,
  draftManufacture,
  dryRunManufacture,
  listManufactureProposals,
  rollbackManufacture,
} from "@kit/job";
import {
  type ComponentKind,
  componentsRoot,
  listComponents,
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

export function registerManufacture(program: Command): void {
  const manufacture = program
    .command("manufacture")
    .description(
      "Draft, dry-run and accept agent/workflow/pipeline/component assets (98 I-6)",
    );

  manufacture
    .command("draft")
    .description("Draft a manufacture proposal; nothing is written to the pack")
    .requiredOption("--pack <dir>", "target pack directory")
    .requiredOption(
      "--kind <kind>",
      "agent|manager|workflow|pipeline|component",
    )
    .requiredOption("--intent <text>", "one-sentence intent")
    .option("--id <id>", "asset id for agent/workflow/pipeline")
    .option("--agent <id>", "existing agent to edit")
    .option(
      "--component <kind:id>",
      "component to assemble (repeatable, for --kind component)",
      collectValues,
      [],
    )
    .option("--allow-command", "allow command-adapter tools", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        pack: string;
        kind: string;
        intent: string;
        id?: string;
        agent?: string;
        component: string[];
        allowCommand?: boolean;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const kind = options.kind;
        if (!isKind(kind)) {
          emitError(
            json,
            new Error(`kind must be one of ${MANUFACTURE_KINDS.join(", ")}`),
          );
          return;
        }
        const componentIds: ManufactureComponentRequest[] = [];
        for (const raw of options.component) {
          const [kind, id] = raw.split(":");
          if (!kind || !id || !(COMPONENT_KINDS as string[]).includes(kind)) {
            emitError(
              json,
              new Error(
                `invalid --component ${raw}; expected <agent|workflow|toolpack|skillpack>:<id>`,
              ),
            );
            return;
          }
          componentIds.push({ kind: kind as ComponentKind, id });
        }
        const available = (
          await listComponents(componentsRoot()).catch(() => [])
        )
          .filter((component) => component.valid)
          .map((component) => ({ kind: component.kind, id: component.id }));

        try {
          const proposal = await draftManufacture({
            kind,
            intent: options.intent,
            packDir: options.pack,
            ...(options.id ? { assetId: options.id } : {}),
            ...(options.agent ? { agentId: options.agent } : {}),
            ...(componentIds.length > 0 ? { componentIds } : {}),
            availableComponents: available,
            allowCommand: options.allowCommand === true,
          });
          emit(json, proposal, () => {
            console.log(
              `${proposal.status === "rejected" ? "✖" : "✓"} ${proposal.kind} ${proposal.assetId} (${proposal.model})`,
            );
            console.log(`  proposal ${proposal.id}`);
            console.log(`  ${proposal.rationale}`);
            for (const issue of proposal.issues) {
              console.log(`  ! ${issue.code} ${issue.path}: ${issue.message}`);
            }
            console.log(
              `next: kit manufacture dry-run --pack ${options.pack} --proposal ${proposal.id}`,
            );
          });
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  manufacture
    .command("dry-run")
    .description("Validate, simulate and preview in a throwaway pack copy")
    .requiredOption("--pack <dir>", "target pack directory")
    .requiredOption("--proposal <id>", "proposal id")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { pack: string; proposal: string; json?: boolean }) => {
        const json = wantsJson(options);
        try {
          const proposal = await dryRunManufacture(
            options.pack,
            options.proposal,
            { library: workshopComponentLibrary(componentsRoot()) },
          );
          emit(json, proposal.dryRun, () => {
            for (const step of proposal.dryRun?.steps ?? []) {
              console.log(`${step.ok ? "✓" : "✖"} ${step.id}: ${step.detail}`);
            }
            for (const file of proposal.dryRun?.preview ?? []) {
              console.log(`  + ${file.path} (${file.bytes} B)`);
            }
            console.log(
              proposal.dryRun?.ok
                ? `next: kit manufacture accept --pack ${options.pack} --proposal ${proposal.id}`
                : "dry-run failed; nothing was written",
            );
          });
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  manufacture
    .command("accept")
    .description(
      "Accept an accepted-proposal candidate; writes the asset, lockfile and audit",
    )
    .requiredOption("--pack <dir>", "target pack directory")
    .requiredOption("--proposal <id>", "proposal id")
    .option("--approved", "approve permission/tool expansion", false)
    .option("--actor <name>", "operator name for the audit record")
    .option("--note <text>", "audit note")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        pack: string;
        proposal: string;
        approved?: boolean;
        actor?: string;
        note?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const proposal = await acceptManufacture(
            options.pack,
            {
              proposalId: options.proposal,
              approved: options.approved === true,
              ...(options.actor ? { actor: options.actor } : {}),
              ...(options.note ? { note: options.note } : {}),
            },
            { library: workshopComponentLibrary(componentsRoot()) },
          );
          emit(json, proposal, () => {
            console.log(
              `✓ accepted ${proposal.kind} ${proposal.assetId} v${proposal.acceptance?.provenance.version}`,
            );
            for (const file of proposal.acceptance?.files ?? []) {
              console.log(`  + ${file}`);
            }
          });
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  manufacture
    .command("rollback")
    .description(
      "Restore the pack to its pre-accept state and drop the lock entry",
    )
    .requiredOption("--pack <dir>", "target pack directory")
    .requiredOption("--proposal <id>", "proposal id")
    .option("--actor <name>", "operator name for the audit record")
    .option("--note <text>", "audit note")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        pack: string;
        proposal: string;
        actor?: string;
        note?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const proposal = await rollbackManufacture(
            options.pack,
            options.proposal,
            {
              ...(options.actor ? { actor: options.actor } : {}),
              ...(options.note ? { note: options.note } : {}),
            },
          );
          emit(json, proposal, () => {
            console.log(`✓ rolled back ${proposal.kind} ${proposal.assetId}`);
          });
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  manufacture
    .command("list")
    .description("List manufacture proposals for a pack")
    .requiredOption("--pack <dir>", "target pack directory")
    .option("--json", "machine-readable output", false)
    .action(async (options: { pack: string; json?: boolean }) => {
      const json = wantsJson(options);
      const proposals = await listManufactureProposals(options.pack);
      emit(json, proposals, () => {
        if (proposals.length === 0) {
          console.log("no manufacture proposals");
          return;
        }
        for (const proposal of proposals) {
          console.log(
            `${proposal.status.padEnd(12)} ${proposal.kind} ${proposal.assetId}  ${proposal.id}`,
          );
        }
      });
    });
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isKind(value: string): value is ManufactureAssetKind {
  return (MANUFACTURE_KINDS as readonly string[]).includes(value);
}
