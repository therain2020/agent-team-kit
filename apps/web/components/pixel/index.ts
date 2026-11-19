/**
 * Shared pixel motion primitives (issue #166).
 *
 * Exported for reuse by `/office`, `/factory` and later the World surface.
 * Everything here renders from data + the quantized ticker; nothing animates
 * on its own.
 */

export { AGENT_PALETTES, MANAGER_PALETTE, agentPalette } from "./palette";
export type { AgentPalette } from "./palette";
export {
  PixelMotionProvider,
  PixelMotionToggle,
  usePixelMotion,
} from "./use-pixel-motion";
export { PixelAgent } from "./pixel-agent";
export { PixelDesk, PixelProgress } from "./pixel-desk";
export { PixelPlant } from "./pixel-plant";
export { PixelRoom } from "./pixel-room";
export { PixelWorkpiece, workpieceTone } from "./pixel-workpiece";
export type { WorkpieceTone } from "./pixel-workpiece";
export { PixelCrate } from "./pixel-crate";
export type { CrateTone } from "./pixel-crate";
export {
  CONVEYOR_PHASE_TICKS,
  CONVEYOR_SPACING_PX,
  CONVEYOR_STEP_PX,
  ConveyorBelt,
  ConveyorReverse,
  REVERSE_MS,
  conveyorOffset,
  useConveyorReverse,
  useShake,
} from "./conveyor";
export { StampEffect } from "./stamp-effect";
export { TOOL_BUBBLE_MS, ToolBubble } from "./tool-bubble";
export { PixelClockControls } from "./pixel-clock-controls";
