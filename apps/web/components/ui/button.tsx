import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

/**
 * Pixel Foundry button: hard 1px border, blur-free offset shadow, and a
 * 1px "press" translation on :active. Variant and size names are stable.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-none border font-mono text-[11px] font-bold uppercase tracking-[0.08em] whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-75 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-px-accent-hi bg-px-accent text-px-accent-ink shadow-px-sm hover:border-px-cream hover:bg-px-accent-hi active:translate-x-px active:translate-y-px active:shadow-none",
        secondary:
          "border-px-line2 bg-px-panel3 text-px-text shadow-px-sm hover:border-zinc-600 hover:bg-px-hi hover:text-px-strong active:translate-x-px active:translate-y-px active:shadow-none",
        outline:
          "border-px-line2 bg-transparent text-px-text shadow-px-sm hover:border-zinc-600 hover:bg-px-panel3 hover:text-px-strong active:translate-x-px active:translate-y-px active:shadow-none",
        ghost:
          "border-transparent bg-transparent text-px-muted hover:border-px-line hover:bg-px-panel3 hover:text-px-text",
        destructive:
          "border-red-300 bg-px-danger text-destructive-foreground shadow-px-sm hover:border-px-cream hover:bg-red-300 active:translate-x-px active:translate-y-px active:shadow-none",
        link: "border-transparent bg-transparent p-0 text-px-accent underline-offset-4 hover:text-px-accent-hi hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[10px]",
        lg: "h-9 px-4 text-[11.5px]",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { buttonVariants };
