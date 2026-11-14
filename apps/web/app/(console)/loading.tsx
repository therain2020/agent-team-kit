export default function ConsoleLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading console">
      <div className="space-y-2">
        <div className="h-6 w-56 animate-pulse rounded bg-zinc-800/70" />
        <div className="h-3 w-96 max-w-full animate-pulse rounded bg-zinc-800/50" />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {["stat-a", "stat-b", "stat-c", "stat-d"].map((key) => (
          <div
            key={key}
            className="h-20 animate-pulse rounded-lg border border-border bg-card"
          />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-5">
          {["panel-a", "panel-b"].map((key) => (
            <div
              key={key}
              className="h-64 animate-pulse rounded-lg border border-border bg-card"
            />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-lg border border-border bg-card" />
      </div>
    </div>
  );
}
