import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";

/**
 * Blocky status chip. Square corners, 1px border, monospace caps.
 * Variant names are stable across the app.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-none border px-1.5 py-0.5 font-mono text-[10px] leading-none font-bold tracking-[0.12em] uppercase whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-px-line2 bg-px-panel3 text-px-muted",
        outline: "border-px-line2 bg-transparent text-px-muted",
        success: "border-emerald-700 bg-px-ok-bg text-emerald-300",
        warning: "border-amber-700 bg-px-warn-bg text-amber-300",
        danger: "border-red-700 bg-px-danger-bg text-red-300",
        info: "border-sky-800 bg-px-info-bg text-sky-300",
        violet: "border-px-violet bg-px-violet-bg text-violet-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
