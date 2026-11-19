import { cn } from "@/lib/utils";
import type * as React from "react";

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full rounded-none border border-px-line2 bg-px-ink px-2.5 py-2 font-mono text-[13px] text-px-text shadow-px-inset outline-none transition-colors placeholder:text-px-faint focus-visible:border-px-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
