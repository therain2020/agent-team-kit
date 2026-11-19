"use client";

import { cn } from "@/lib/utils";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs rounded-none border border-px-line2 bg-px-panel2 px-2 py-1 font-mono text-[11px] text-px-text shadow-px-sm",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
