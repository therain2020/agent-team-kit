import { cn } from "@/lib/utils";
import type * as React from "react";

export function Input({
  className,
  type,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full rounded-none border border-px-line2 bg-px-ink px-2.5 py-1 font-mono text-[13px] text-px-text shadow-px-inset outline-none transition-colors placeholder:text-px-faint focus-visible:border-px-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
