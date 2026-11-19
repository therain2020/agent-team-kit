import { cn } from "@/lib/utils";

/**
 * Desk + monitor sprite shared by the office floor and the factory view.
 *
 * The screen blink is the only CSS motion here; it is applied through
 * `animated`, which callers tie to the shared motion policy so reduced-motion
 * users get a still desk and the exact same information.
 */
export function PixelDesk({
  progress,
  animated = false,
  className,
}: {
  progress?: number;
  animated?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("relative w-full max-w-[10rem]", className)}
      aria-hidden="true"
    >
      <div className="mx-auto h-1.5 w-full rounded-none bg-[#2b3446]" />
      <div className="mx-auto -mt-0.5 flex h-6 w-[86%] items-center justify-center rounded-none border border-[#1c2433] bg-[#1f2839] shadow-[0_4px_0_#141b28]">
        <span
          className={cn(
            "h-2.5 w-8 rounded-none bg-sky-400/40",
            animated && "office-screen",
          )}
        />
      </div>
      <div className="mx-auto mt-0.5 h-1 w-[40%] rounded-none bg-zinc-700" />
      <PixelProgress progress={progress} className="mt-1" />
    </div>
  );
}

/**
 * Deterministic stage progress bar. The status chip and the stage/percent text
 * carry the same information; this bar is decoration only.
 */
export function PixelProgress({
  progress,
  className,
}: {
  progress?: number;
  className?: string;
}) {
  if (typeof progress !== "number") {
    return null;
  }
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <span
      className={cn("block h-1 w-full rounded-none bg-zinc-800", className)}
      aria-hidden="true"
    >
      <span
        className="block h-full rounded-none bg-emerald-400/80 motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}
