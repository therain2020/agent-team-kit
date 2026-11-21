import type { PixelAgentState } from "@/lib/pixel-events";
import { cn } from "@/lib/utils";
import {
  type AvatarSpec,
  avatarRects,
  normalizeAvatar,
} from "@kit/core/avatar";
import {
  type AgentPalette,
  MANAGER_PALETTE,
  PIXEL_AMBER,
  PIXEL_GREEN,
  PIXEL_RED,
  agentPalette,
} from "./palette";

/**
 * 16×24 office sprite with four data states.
 *
 * A valid custom `avatar` (97 §3.4) takes precedence over the procedural seed
 * sprite; invalid data falls back to the seed palette instead of crashing.
 * Manager identity stays on the DOM (badge), not baked into the sprite.
 *
 * Two-frame stepping is driven by the shared clock: `tick % 2` toggles the
 * working frame (bob + tool spark + blink), so a paused, event-free scene is
 * completely still. Blocked/waiting draw their marker on the fixed frame.
 */
export function PixelAgent({
  seed,
  manager = false,
  state,
  tick = 0,
  tone,
  scale = 1,
  avatar,
  className,
}: {
  seed: number;
  manager?: boolean;
  state: PixelAgentState;
  /** Shared game-clock tick; only parity matters. */
  tick?: number;
  /** Override the state accent (office uses red for `error`). */
  tone?: "amber" | "red";
  scale?: number;
  /** Optional persisted 16×24 sprite drawn ahead of the seed palette. */
  avatar?: AvatarSpec | null;
  className?: string;
}) {
  const palette: AgentPalette = manager ? MANAGER_PALETTE : agentPalette(seed);
  const custom = avatar ? normalizeAvatar(avatar) : null;
  const customRects = custom ? avatarRects(custom) : null;
  const working = state === "working";
  const frame = Math.abs(Math.trunc(tick)) % 2;
  const workingFrame = working && frame === 1;
  const accent = tone === "red" ? PIXEL_RED : PIXEL_AMBER;
  const width = Math.round((manager ? 54 : 42) * scale);
  const height = Math.round((manager ? 76 : 60) * scale);

  return (
    <svg
      viewBox="0 0 16 24"
      width={width}
      height={height}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={cn("drop-shadow-[0_6px_8px_rgba(0,0,0,0.45)]", className)}
      style={{
        transform: workingFrame ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      <ellipse cx="8" cy="23" rx="5" ry="1" fill="rgba(0,0,0,0.35)" />
      {customRects ? (
        <>
          {customRects.map((pixel) => (
            <rect
              key={`${pixel.x}-${pixel.y}`}
              x={pixel.x}
              y={pixel.y}
              width="1"
              height="1"
              fill={pixel.color}
            />
          ))}
        </>
      ) : (
        <>
          <rect x="5" y="18" width="2" height="4" fill={palette.pants} />
          <rect x="9" y="18" width="2" height="4" fill={palette.pants} />
          <rect x="4" y="22" width="3" height="1" fill="#111827" />
          <rect x="9" y="22" width="3" height="1" fill="#111827" />
          <rect x="4" y="11" width="8" height="7" fill={palette.shirt} />
          <rect x="3" y="12" width="1" height="5" fill={palette.shirt} />
          <rect x="12" y="12" width="1" height="5" fill={palette.shirt} />
          <rect x="4" y="9" width="8" height="2" fill={palette.shirt} />
          <rect x="5" y="4" width="6" height="6" fill={palette.skin} />
          <rect x="4" y="3" width="8" height="2" fill={palette.hair} />
          <rect x="4" y="4" width="2" height="3" fill={palette.hair} />
          <rect x="10" y="4" width="2" height="3" fill={palette.hair} />
          {workingFrame ? (
            <>
              <rect x="5" y="7" width="2" height="1" fill="#1f2937" />
              <rect x="9" y="7" width="2" height="1" fill="#1f2937" />
            </>
          ) : (
            <>
              <rect x="6" y="7" width="1" height="1" fill="#1f2937" />
              <rect x="9" y="7" width="1" height="1" fill="#1f2937" />
            </>
          )}
          <rect x="7" y="9" width="2" height="0.5" fill="#b5766a" />
          {manager ? (
            <>
              <rect x="7" y="6" width="2" height="4" fill="#f5f5f4" />
              <rect x="7.5" y="7" width="1" height="3" fill="#9f1239" />
              <rect x="4" y="9" width="8" height="1" fill="#1f2937" />
            </>
          ) : null}
        </>
      )}
      {state === "blocked" ? (
        <>
          <rect x="13" y="0" width="1" height="3" fill={accent} />
          <rect x="13" y="4" width="1" height="1" fill={accent} />
        </>
      ) : null}
      {state === "waiting" ? (
        <>
          <rect x="12" y="14" width="3" height="3" fill="#c9a06a" />
          <rect x="12" y="14" width="3" height="1" fill="#e8c49a" />
          <rect x="15" y="15" width="1" height="1" fill="#c9a06a" />
        </>
      ) : null}
      {workingFrame ? (
        <>
          <rect x="13" y="11" width="1" height="3" fill="#c9d3e0" />
          <rect x="13" y="10" width="1" height="1" fill={PIXEL_AMBER} />
        </>
      ) : null}
      {working ? (
        <rect
          x="4"
          y="9"
          width="1"
          height="1"
          fill={PIXEL_GREEN}
          opacity="0.7"
        />
      ) : null}
    </svg>
  );
}
