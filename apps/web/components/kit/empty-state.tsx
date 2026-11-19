import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-none border border-dashed border-px-line2 bg-px-panel/40 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon ? <Icon className="mb-3 size-6 text-px-faint" /> : null}
      <p className="font-mono text-[13px] font-bold tracking-[0.08em] text-px-text uppercase">
        {title}
      </p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-px-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
