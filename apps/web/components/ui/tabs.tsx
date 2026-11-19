"use client";

import { cn } from "@/lib/utils";
import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";

export function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex h-8 items-center gap-0.5 rounded-none border border-px-line2 bg-px-ink p-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center rounded-none border border-transparent px-2.5 py-1 font-mono text-[10.5px] font-bold tracking-[0.1em] text-px-muted uppercase outline-none transition-colors hover:border-px-line hover:bg-px-panel3 hover:text-px-text data-[state=active]:border-px-accent data-[state=active]:bg-px-accent data-[state=active]:text-px-accent-ink disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("outline-none", className)}
      {...props}
    />
  );
}
