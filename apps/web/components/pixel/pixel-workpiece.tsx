import type { CrateTone } from "./pixel-crate";
import { PixelCrate } from "./pixel-crate";

export type WorkpieceTone = CrateTone;

/**
 * Workpiece on the factory belt. This is a thin face over `PixelCrate` — the
 * sprite itself lives once in the shared pixel layer — that projects an
 * approval item onto the risk tone vocabulary.
 */
export function workpieceTone(item: {
  kind: string;
  riskClass: WorkpieceTone;
}): WorkpieceTone {
  return item.kind === "failed" ? "bad" : item.riskClass;
}

export function PixelWorkpiece({
  item,
  size = 32,
  className,
}: {
  item: { kind: string; riskClass: WorkpieceTone };
  size?: number;
  className?: string;
}) {
  return (
    <PixelCrate tone={workpieceTone(item)} size={size} className={className} />
  );
}
