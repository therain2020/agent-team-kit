#!/usr/bin/env bun
import { DEFAULT_LKG_TARGET_KEY } from "@kit/core";
import { initStore } from "@kit/store";

/**
 * One-click artifact LKG switch (61 §5). Dry-run by default; `--execute`
 * supersedes the current pin and writes the switch to the op log.
 */
const execute = process.argv.includes("--execute");
const workspaceId = argValue("--workspace") ?? "default";
const targetKey = argValue("--target") ?? DEFAULT_LKG_TARGET_KEY;
const artifactId = argValue("--artifact");
const version = Number(argValue("--version") ?? "1");
const verifiedBy = argValue("--verified-by") ?? "operator:lkg-switch";

if (!artifactId) {
  console.error(
    "usage: bun run scripts/lkg-switch.ts --artifact <id> [--version 1] [--workspace default] [--target <key>] [--verified-by <who>] [--execute]",
  );
  process.exit(2);
}
if (!Number.isInteger(version) || version < 1) {
  console.error("--version must be a positive integer");
  process.exit(2);
}

const store = await initStore();
let failed = false;

try {
  const current = await store.lkg.listActive(workspaceId);
  const previous = current
    .filter((record) => record.targetKey === targetKey)
    .map((record) => record.lkgId);

  if (!execute) {
    console.log(
      `dry run (pass --execute to switch) workspace=${workspaceId} target=${targetKey}`,
    );
    console.log(
      `  next      ${artifactId}@${version} (verifier ${verifiedBy})`,
    );
    console.log(
      `  previous  ${previous.length > 0 ? previous.join(", ") : "(none)"}`,
    );
  } else {
    const result = await store.lkgService.register({
      workspaceId,
      targetKey,
      artifactRefs: [{ artifactId, version }],
      verifier: verifiedBy,
      createdBy: verifiedBy,
    });

    console.log(
      JSON.stringify(
        {
          switched: result.changed,
          lkgId: result.record.lkgId,
          artifactId,
          version,
          workspaceId,
          targetKey,
          verifiedAt: result.record.verifiedAt,
          verifier: result.record.verifier,
          previous: result.previous.map((record) => record.lkgId),
          audited: result.audited,
        },
        null,
        2,
      ),
    );

    if (!result.audited) {
      failed = true;
      console.error(
        "warning: switch applied but the op-log audit entry is missing",
      );
    }
  }
} finally {
  await store.close();
}

if (failed) {
  process.exitCode = 1;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
