"use client";

import { cn } from "@/lib/utils";
import { Separator as SeparatorPrimitive } from "radix-ui";
import type * as React from "react";

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0",
        orientation === "horizontal" ? "pixel-sep-h" : "pixel-sep-v",
        className,
      )}
      {...props}
    />
  );
}
