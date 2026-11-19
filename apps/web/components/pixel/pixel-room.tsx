import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Shared pixel world shell: floor grid, inset shadow and the padded stage that
 * rooms render into. The office floor and the factory both mount their content
 * inside one so the two rooms cannot drift apart visually (97 §3.5).
 */
export function PixelRoom({
  children,
  className,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <div
      className={cn(
        "office-room relative overflow-hidden rounded-none border-2 border-px-line bg-px-bg p-4 shadow-[inset_0_0_80px_rgba(0,0,0,0.6)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(122,162,247,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(122,162,247,0.12)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className={cn("relative", innerClassName)}>{children}</div>
    </div>
  );
}
