import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-none bg-px-panel3 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
