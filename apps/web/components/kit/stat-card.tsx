import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-none border border-px-line bg-px-panel2 px-3 py-2.5 shadow-px-sm",
        className,
      )}
    >
      <p className="font-mono text-[10px] leading-none font-bold tracking-[0.14em] text-px-muted uppercase">
        {label}
      </p>
      <p className="mt-1.5 font-mono text-[17px] leading-none font-bold text-px-strong tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="mt-1.5 text-[10.5px] leading-snug text-px-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
