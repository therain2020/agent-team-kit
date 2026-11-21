import { resolvePackDir } from "@/lib/paths";
import { loadPipelineInventory } from "@/lib/pipeline-inventory";
import type { ComponentRef } from "@kit/core";
import { NextResponse } from "next/server";

/**
 * Component library snapshot for the pipeline review step (94 C-6c+).
 *
 * The review UI edits component refs and bindings against the same inventory
 * the composer used. Read-only: it never assembles or writes; approval still
 * goes through `POST /api/packs/[dir]/assemble`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }
  try {
    const inventory = await loadPipelineInventory(packDir);
    const locked = new Map(
      inventory.locked.map((ref: ComponentRef) => [
        `${ref.kind}/${ref.id}`,
        ref.version,
      ]),
    );
    return NextResponse.json({
      components: inventory.components.map((entry) => ({
        ...entry,
        ...(locked.has(`${entry.kind}/${entry.id}`)
          ? { lockedVersion: locked.get(`${entry.kind}/${entry.id}`) }
          : {}),
      })),
      invalid: inventory.invalid,
      locked: inventory.locked,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "inventory failed",
      },
      { status: 502 },
    );
  }
}
