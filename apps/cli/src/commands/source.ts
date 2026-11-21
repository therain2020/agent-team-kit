import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "@kit/core";
import { draftAuthoredSource } from "@kit/job";
import {
  SOURCE_TOPIC,
  collectOnce,
  createSourceProposal,
  draftInterestProfile,
  fetchEvidence,
  installSource,
  installSourceProposal,
  listInstalledSources,
  listRetirementProposals,
  listSourceProposals,
  loadInstalledSource,
  removeSource,
  retireSource,
  searchSources,
  setSourceBudget,
  testSource,
  updateSourceDefinition,
} from "@kit/source";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerSource(program: Command): void {
  const source = program.command("source").description("Sources and market");

  source
    .command("fetch")
    .description("Fetch evidence from builtin or installed sources")
    .option("--sources <list>", "comma-separated source names", "hn,arxiv")
    .option("--limit <n>", "per-source item limit", "5")
    .option("--out <path>", "output file", ".tmp/evidence.json")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        sources: string;
        limit: string;
        out: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const sources = options.sources
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

        if (sources.length === 0) {
          emitError(json, new CliError("usage", "no valid sources"));
          return;
        }

        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          emitError(
            json,
            new CliError("usage", "--limit must be a positive integer"),
          );
          return;
        }

        try {
          const evidence = await fetchEvidence({ sources, limit });
          const outPath = path.resolve(options.out);
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, JSON.stringify(evidence, null, 2), "utf8");

          const data = {
            out: outPath,
            sources: evidence.sources.length,
            citations: evidence.sources.map((item) => item.citationId),
            errors: evidence.errors,
          };
          emit(json, data, () => {
            console.log(JSON.stringify(data, null, 2));
          });
        } catch (error) {
          report("fetch", error, json);
        }
      },
    );

  source
    .command("collect")
    .description(
      "Run one information collection pass and persist events (98 I-1)",
    )
    .option("--sources <list>", "comma-separated source names", "hn,arxiv")
    .option("--limit <n>", "per-source item limit", "5")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { sources: string; limit: string; json?: boolean }) => {
        const json = wantsJson(options);
        const sources = options.sources
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (sources.length === 0) {
          emitError(json, new CliError("usage", "no valid sources"));
          return;
        }
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          emitError(
            json,
            new CliError("usage", "--limit must be a positive integer"),
          );
          return;
        }

        const store = await initStore();
        try {
          const summary = await collectOnce(store, { sources, limit });
          emit(json, summary, () => {
            for (const item of summary.sources) {
              const status = item.ok
                ? `${item.eventsCreated} new, ${item.duplicates} dup`
                : `FAILED: ${item.error ?? "unknown"}`;
              console.log(
                `${item.sourceId}  ${status}  ${item.latencyMs}ms${
                  item.degraded ? "  [degraded]" : ""
                }`,
              );
            }
            console.log(
              `total: ${summary.eventsCreated} new / ${summary.duplicates} duplicate / ${summary.failures} failed`,
            );
          });
        } catch (error) {
          report("collect", error, json);
        } finally {
          await store.close();
        }
      },
    );

  source
    .command("health")
    .description("Show per-source collection health (success, latency, yield)")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const health = await store.information.listSourceHealth();
        emit(json, { sources: health }, () => {
          if (health.length === 0) {
            console.log(
              "No source health yet. Run: kit source collect --sources hn,arxiv",
            );
            return;
          }
          for (const item of health) {
            const avgMs =
              item.runs > 0 ? Math.round(item.latencyMsTotal / item.runs) : 0;
            console.log(
              `${item.sourceId}  runs=${item.runs} ok=${item.successes} fail=${item.failures} streak=${item.consecutiveFailures} items=${item.itemsCollected} events=${item.eventsCreated} avg=${avgMs}ms${item.degraded ? "  [degraded]" : ""}`,
            );
          }
        });
      } catch (error) {
        report("health", error, json);
      } finally {
        await store.close();
      }
    });

  const profile = source
    .command("profile")
    .description(
      "Show the current InterestProfile (topics, entities, thresholds, version)",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const [current, audit] = await Promise.all([
          store.interestProfiles.getCurrent(),
          store.interestProfiles.listAudit("default", 5),
        ]);
        const effective =
          current ?? (await store.interestProfiles.getCurrentOrDefault());
        emit(
          json,
          { profile: effective, persisted: current !== null, audit },
          () => {
            console.log(
              `profile ${effective.profileId} v${effective.version} (${effective.updatedBy})`,
            );
            console.log(`  topics: ${effective.topics.join(", ") || "—"}`);
            console.log(`  entities: ${effective.entities.join(", ") || "—"}`);
            console.log(
              `  exclusions: ${effective.exclusions.join(", ") || "—"}`,
            );
            const t = effective.thresholds;
            console.log(
              `  thresholds: relevance ${t.relevance} · novelty ${t.novelty} · urgency ${t.urgency}`,
            );
            console.log(`  daily budget: ${effective.dailyBudgetCny} CNY`);
            console.log(`  rationale: ${effective.rationale}`);
            if (audit.length > 0) {
              console.log("  history:");
              for (const entry of audit) {
                console.log(
                  `    v${entry.version} ${entry.action} by ${entry.actor} — ${entry.rationale}`,
                );
              }
            }
          },
        );
      } catch (error) {
        report("profile", error, json);
      } finally {
        await store.close();
      }
    });

  profile
    .command("propose")
    .description(
      "Turn one sentence of intent into a heuristic InterestProfile draft (no side effects)",
    )
    .requiredOption(
      "--intent <text>",
      "what the team cares about, in one sentence",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: { intent: string; json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const base = await store.interestProfiles.getCurrent();
        const draft = draftInterestProfile(options.intent, base);
        emit(json, draft, () => {
          console.log(JSON.stringify(draft, null, 2));
          console.log(
            "\nDraft only; nothing was saved. Review it, then run `kit source profile set ... --rationale <sentence>`.",
          );
        });
      } catch (error) {
        report("profile propose", error, json);
      } finally {
        await store.close();
      }
    });

  profile
    .command("set")
    .description("Write a new interest profile version plus an audit record")
    .option("--topics <list>", "comma-separated topics")
    .option("--entities <list>", "comma-separated entities")
    .option("--exclusions <list>", "comma-separated excluded terms")
    .option("--relevance <n>", "relevance threshold 0..1")
    .option("--novelty <n>", "novelty threshold 0..1")
    .option("--urgency <n>", "urgency threshold 0..1")
    .option("--budget <cny>", "daily information budget in CNY")
    .option("--updated-by <who>", "human|ai", "human")
    .option("--expected-version <n>", "reject if the current version differs")
    .requiredOption("--rationale <text>", "one sentence explaining the change")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        topics?: string;
        entities?: string;
        exclusions?: string;
        relevance?: string;
        novelty?: string;
        urgency?: string;
        budget?: string;
        updatedBy: string;
        expectedVersion?: string;
        rationale: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const current = await store.interestProfiles.getCurrentOrDefault();
          const thresholds = {
            relevance: parseRatio(
              options.relevance,
              current.thresholds.relevance,
            ),
            novelty: parseRatio(options.novelty, current.thresholds.novelty),
            urgency: parseRatio(options.urgency, current.thresholds.urgency),
          };
          const updatedBy =
            options.updatedBy === "ai" || options.updatedBy === "human"
              ? options.updatedBy
              : undefined;
          if (!updatedBy) {
            emitError(
              json,
              new CliError("usage", "--updated-by must be human or ai"),
            );
            return;
          }
          const expectedVersion = parseOptionalInt(options.expectedVersion);
          const saved = await store.interestProfiles.saveProfile({
            topics: parseList(options.topics) ?? current.topics,
            entities: parseList(options.entities) ?? current.entities,
            exclusions: parseList(options.exclusions) ?? current.exclusions,
            thresholds,
            dailyBudgetCny:
              options.budget === undefined
                ? current.dailyBudgetCny
                : parseNonNegative(options.budget, "--budget"),
            updatedBy,
            actor: "cli",
            rationale: options.rationale,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          });
          emit(json, { profile: saved }, () => {
            console.log(
              `✔ interest profile v${saved.version} saved (${saved.updatedBy})`,
            );
            console.log(`  topics: ${saved.topics.join(", ") || "—"}`);
            console.log(`  rationale: ${saved.rationale}`);
            console.log(
              "New events are scored with these thresholds; historical scores are unchanged.",
            );
          });
        } catch (error) {
          report("profile set", error, json);
        } finally {
          await store.close();
        }
      },
    );

  source
    .command("events")
    .description("List recent information events with their signal scores")
    .option("--limit <n>", "max events", "20")
    .option("--json", "machine-readable output", false)
    .action(async (options: { limit: string; json?: boolean }) => {
      const json = wantsJson(options);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        emitError(
          json,
          new CliError("usage", "--limit must be a positive integer"),
        );
        return;
      }
      const store = await initStore();
      try {
        const events = await store.information.listEvents({ limit });
        const rows = events.map((event) => ({
          eventId: event.eventId,
          title: event.title,
          sourceId: event.sourceId,
          occurredAt: event.occurredAt,
          signals: event.payload.signals ?? null,
        }));
        emit(json, { events: rows }, () => {
          if (rows.length === 0) {
            console.log("No information events yet.");
            return;
          }
          for (const row of rows) {
            const s = row.signals;
            console.log(
              `${row.sourceId}  ${row.title || row.eventId}${
                s
                  ? `  rel=${s.relevance} nov=${s.novelty} urg=${s.urgency} risk=${s.risk} conf=${s.confidence} [${s.model}]`
                  : "  [unscored]"
              }`,
            );
            for (const reason of s?.reasons ?? []) {
              console.log(`    · ${reason}`);
            }
            if (s && s.flags.length > 0) {
              console.log(`    flags: ${s.flags.join(", ")}`);
            }
          }
        });
      } catch (error) {
        report("events", error, json);
      } finally {
        await store.close();
      }
    });

  source
    .command("audit")
    .description(
      "Sample stored signal audits and verify every event has reasons",
    )
    .option("--size <n>", "sample size", "10")
    .option("--json", "machine-readable output", false)
    .action(async (options: { size: string; json?: boolean }) => {
      const json = wantsJson(options);
      const size = Number(options.size);
      if (!Number.isInteger(size) || size <= 0) {
        emitError(
          json,
          new CliError("usage", "--size must be a positive integer"),
        );
        return;
      }
      const store = await initStore();
      try {
        const rows = await store.interestProfiles.sampleSignals(
          "default",
          size,
        );
        const ok =
          rows.length > 0 &&
          rows.every(
            (row) =>
              row.reasons.length > 0 &&
              ["heuristic", "model"].includes(row.model) &&
              row.relevance >= 0 &&
              row.relevance <= 1,
          );
        emit(json, { ok, sampled: rows.length, signals: rows }, () => {
          if (rows.length === 0) {
            console.log("No signal audits yet. Run: kit source collect");
          } else {
            for (const row of rows) {
              console.log(
                `${row.eventId}  v${row.profileVersion} ${row.model}  rel=${row.relevance} nov=${row.novelty} urg=${row.urgency} risk=${row.risk} conf=${row.confidence}  reasons=${row.reasons.length}`,
              );
            }
          }
          console.log(
            ok
              ? `✔ sampling audit passed (${rows.length} event(s))`
              : "× sampling audit failed: missing scores or reasons",
          );
          if (!ok) {
            process.exitCode = 1;
          }
        });
      } catch (error) {
        report("audit", error, json);
      } finally {
        await store.close();
      }
    });

  source
    .command("search")
    .description(
      `Discover sources tagged with the ${SOURCE_TOPIC} GitHub topic`,
    )
    .option("--query <text>", "extra GitHub search terms")
    .option("--topic <name>", "GitHub topic", SOURCE_TOPIC)
    .option("--limit <n>", "max repositories", "12")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        query?: string;
        topic: string;
        limit: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const candidates = await searchSources({
            query: options.query,
            topic: options.topic,
            limit: Number(options.limit),
            token: process.env.GITHUB_TOKEN,
          });
          emit(json, { candidates }, () => {
            if (candidates.length === 0) {
              console.log("No sources found.");
              return;
            }
            for (const item of candidates) {
              const label = item.manifest
                ? `${item.manifest.metadata.name}@${item.manifest.metadata.version}`
                : "invalid manifest";
              console.log(
                `${item.repo}  ★${item.stars}  ${label}${
                  item.manifestError ? `  ! ${item.manifestError}` : ""
                }`,
              );
              if (item.description) {
                console.log(`  ${item.description}`);
              }
            }
            console.log(
              "\nInstall with: bun run kit source install <owner/repo> --yes",
            );
          });
        } catch (error) {
          report("search", error, json);
        }
      },
    );

  source
    .command("install <repo>")
    .description(
      "Install a declarative source from GitHub (pinned to a commit)",
    )
    .option("--ref <ref>", "branch, tag or commit (default branch if omitted)")
    .option("--file <path>", "manifest path", "source.yaml")
    .option("--yes", "confirm third-party source installation", false)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        repo: string,
        options: {
          ref?: string;
          file: string;
          yes: boolean;
          idempotencyKey?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        if (!options.yes) {
          emitError(
            json,
            new CliError(
              "needs_confirmation",
              "third-party sources require --yes after reviewing source.yaml",
              {
                hint: `preview: https://github.com/${repo}/blob/HEAD/${options.file}`,
              },
            ),
          );
          return;
        }
        try {
          const installed = await installSource({
            repo,
            ref: options.ref,
            file: options.file,
            token: process.env.GITHUB_TOKEN,
            acceptThirdParty: true,
          });
          const data = {
            name: installed.definition.metadata.name,
            version: installed.definition.metadata.version,
            repo: installed.meta.repo,
            commit: installed.meta.commit,
            manifestSha256: installed.meta.manifestSha256,
            file: installed.file,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          };
          emit(json, data, () => {
            console.log(JSON.stringify(data, null, 2));
            console.log(
              "Third-party source installed. Review its source.yaml and comply with its terms.",
            );
          });
        } catch (error) {
          report("install", error, json);
        }
      },
    );

  source
    .command("list")
    .description("List installed sources")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      const sources = await listInstalledSources();
      emit(json, { sources }, () => {
        if (sources.length === 0) {
          console.log("No installed sources. Builtins: hn, arxiv, github.");
          return;
        }
        for (const item of sources) {
          console.log(
            `${item.definition.metadata.name}@${item.definition.metadata.version}  ${item.meta.repo}@${item.meta.commit.slice(0, 8)}  ${item.meta.trust}`,
          );
        }
      });
    });

  source
    .command("test <name>")
    .description("Fetch a few items from an installed source")
    .option("--limit <n>", "item limit", "3")
    .option("--json", "machine-readable output", false)
    .action(
      async (name: string, options: { limit: string; json?: boolean }) => {
        const json = wantsJson(options);
        try {
          const result = await testSource(name, {
            limit: Number(options.limit),
          });
          emit(json, result, () => {
            console.log(JSON.stringify(result, null, 2));
          });
        } catch (error) {
          report("test", error, json);
        }
      },
    );

  source
    .command("remove <name>")
    .description("Remove an installed source")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        options: { idempotencyKey?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        try {
          await removeSource(name);
          emit(
            json,
            {
              removed: name,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
            },
            () => {
              console.log(`✔ removed ${name}`);
            },
          );
        } catch (error) {
          report("remove", error, json);
        }
      },
    );

  source
    .command("propose")
    .description(
      "Draft a declarative source.yaml proposal from one sentence (98 I-5, no install)",
    )
    .requiredOption("--intent <text>", "what the source should fetch")
    .option(
      "--endpoint <url>",
      "override the endpoint extracted from the intent",
    )
    .option("--name <name>", "override the generated source name")
    .option("--description <text>", "override the generated description")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        intent: string;
        endpoint?: string;
        name?: string;
        description?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const authored = draftAuthoredSource(options.intent, {
            ...(options.endpoint ? { endpoint: options.endpoint } : {}),
            ...(options.name ? { name: options.name } : {}),
            ...(options.description
              ? { description: options.description }
              : {}),
          });
          const proposal = await createSourceProposal({
            intent: options.intent,
            yaml: authored.yaml,
            model: "heuristic",
          });
          emit(json, proposal, () => {
            console.log(
              `${proposal.status === "rejected" ? "✖" : "✓"} ${proposal.status} ${proposal.name} (${proposal.id})`,
            );
            for (const issue of proposal.issues) {
              console.log(`  ! ${issue.code} ${issue.path}: ${issue.message}`);
            }
            console.log(authored.yaml);
            console.log(`next: kit source approve ${proposal.id} --yes`);
          });
        } catch (error) {
          report("propose", error, json);
        }
      },
    );

  source
    .command("proposals")
    .description("List source manufacture and retirement proposals")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const health = await store.information.listSourceHealth();
        const [proposals, retirements] = await Promise.all([
          listSourceProposals(),
          listRetirementProposals({
            health: health.map((row) => ({
              sourceId: row.sourceId,
              runs: row.runs,
              successes: row.successes,
              failures: row.failures,
              itemsCollected: row.itemsCollected,
              eventsCreated: row.eventsCreated,
              consecutiveFailures: row.consecutiveFailures,
              degraded: row.degraded,
            })),
          }),
        ]);
        emit(json, { proposals, retirements }, () => {
          for (const proposal of proposals) {
            console.log(
              `${proposal.status.padEnd(10)} source ${proposal.name}  ${proposal.id}`,
            );
          }
          for (const proposal of retirements) {
            console.log(
              `${proposal.status.padEnd(10)} retire ${proposal.sourceId}  ${proposal.reason}`,
            );
          }
          if (proposals.length === 0 && retirements.length === 0) {
            console.log("no source proposals");
          }
        });
      } catch (error) {
        report("proposals", error, json);
      } finally {
        await store.close();
      }
    });

  source
    .command("approve <proposal>")
    .description("Install a validated source proposal (explicit approval)")
    .option("--yes", "confirm observer approval and install", false)
    .option("--actor <name>", "observer name for the audit record")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        proposalId: string,
        options: { yes: boolean; actor?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        if (!options.yes) {
          emitError(
            json,
            new CliError(
              "needs_confirmation",
              "AI proposals never install themselves; re-run with --yes after reviewing source.yaml",
            ),
          );
          return;
        }
        try {
          const result = await installSourceProposal({
            id: proposalId,
            approved: true,
            ...(options.actor ? { actor: options.actor } : {}),
          });
          emit(json, result.proposal, () => {
            console.log(
              `✓ installed ${result.installed.definition.metadata.name}@${result.installed.definition.metadata.version} (${result.installed.meta.trust})`,
            );
            console.log(`  ${result.installed.file}`);
          });
        } catch (error) {
          report("approve", error, json);
        }
      },
    );

  source
    .command("edit <name>")
    .description("Replace an installed source.yaml after the same gate passes")
    .requiredOption("--yaml <file>", "path to the edited source.yaml")
    .option("--actor <name>", "observer name for the audit record")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        options: { yaml: string; actor?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        try {
          const yaml = await readFile(path.resolve(options.yaml), "utf8");
          const updated = await updateSourceDefinition({
            name,
            yaml,
            ...(options.actor ? { actor: options.actor } : {}),
          });
          emit(
            json,
            { name, version: updated.definition.metadata.version },
            () => {
              console.log(
                `✓ edited ${name}@${updated.definition.metadata.version}`,
              );
            },
          );
        } catch (error) {
          report("edit", error, json);
        }
      },
    );

  source
    .command("budget <name>")
    .description("Set an observer budget for an installed source")
    .option("--daily-cny <n>", "daily cost ceiling in CNY")
    .option("--max-items <n>", "max items per run (1-100)")
    .option("--actor <name>", "observer name for the audit record")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        options: {
          dailyCny?: string;
          maxItems?: string;
          actor?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        try {
          const current = await loadInstalledSource(name);
          if (!current) {
            throw new CliError("not_found", `source not installed: ${name}`);
          }
          const budget = {
            dailyCostCny: parseNonNegative(
              options.dailyCny,
              "--daily-cny",
              current.meta.budget?.dailyCostCny ?? 0,
            ),
            maxItemsPerRun: parseBounded(
              options.maxItems,
              "--max-items",
              current.meta.budget?.maxItemsPerRun ?? 20,
              1,
              100,
            ),
          };
          await setSourceBudget({
            name,
            budget,
            ...(options.actor ? { actor: options.actor } : {}),
          });
          emit(json, { name, budget }, () => {
            console.log(
              `✓ ${name} budget: ${budget.dailyCostCny} CNY/day · ≤${budget.maxItemsPerRun} items/run`,
            );
          });
        } catch (error) {
          report("budget", error, json);
        }
      },
    );

  source
    .command("retire <name>")
    .description(
      "Retire a source; collection stops and all history is kept (never deleted)",
    )
    .option("--reason <text>", "audited reason")
    .option("--proposal <id>", "retirement proposal id to mark applied")
    .option("--actor <name>", "observer name for the audit record")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        name: string,
        options: {
          reason?: string;
          proposal?: string;
          actor?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        try {
          const retired = await retireSource({
            name,
            ...(options.reason ? { reason: options.reason } : {}),
            ...(options.proposal ? { proposalId: options.proposal } : {}),
            ...(options.actor ? { actor: options.actor } : {}),
          });
          emit(
            json,
            {
              name,
              retiredAt: retired.meta.retiredAt,
              retirement: retired.meta.retirement,
            },
            () => {
              console.log(`✓ retired ${name}; manifest and history kept`);
            },
          );
        } catch (error) {
          report("retire", error, json);
        }
      },
    );
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [];
}

function parseRatio(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError("usage", "thresholds must be a number between 0 and 1");
  }
  return parsed;
}

function parseNonNegative(
  value: string | undefined,
  label: string,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError("usage", `${label} must be a non-negative number`);
  }
  return parsed;
}

function parseBounded(
  value: string | undefined,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(
      "usage",
      `${label} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(
      "usage",
      "--expected-version must be a non-negative integer",
    );
  }
  return parsed;
}

function report(command: string, error: unknown, json: boolean): void {
  emitError(
    json,
    new CliError(
      "internal",
      `source ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}
