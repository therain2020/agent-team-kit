import type { FactoryItem, FactoryRisk } from "@/lib/factory";

const ACCENT: Record<FactoryRisk, string> = {
  low: "#34d399",
  medium: "#fbbf24",
  high: "#f87171",
};

export function PixelWorkpiece({
  item,
  size = 32,
}: {
  item: FactoryItem;
  size?: number;
}) {
  const accent = item.kind === "failed" ? ACCENT.high : ACCENT[item.riskClass];
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0"
      aria-hidden="true"
    >
      <rect x="2" y="14" width="12" height="1" fill="#000" opacity="0.4" />
      <rect x="2" y="4" width="12" height="10" fill="#3f3f46" />
      <rect x="2" y="4" width="12" height="1" fill="#71717a" />
      <rect x="2" y="13" width="12" height="1" fill="#27272a" />
      <rect x="2" y="4" width="1" height="10" fill="#52525b" />
      <rect x="13" y="4" width="1" height="10" fill="#18181b" />
      <rect x="2" y="7" width="12" height="2" fill={accent} opacity="0.85" />
      <rect x="4" y="9" width="1" height="4" fill="#52525b" />
      <rect x="11" y="5" width="1" height="4" fill="#52525b" />
      {item.kind === "failed" ? (
        <>
          <rect x="5" y="1" width="6" height="1" fill={accent} />
          <rect x="6" y="0" width="4" height="1" fill={accent} opacity="0.6" />
        </>
      ) : (
        <rect x="7" y="2" width="2" height="1" fill="#a1a1aa" opacity="0.5" />
      )}
    </svg>
  );
}
