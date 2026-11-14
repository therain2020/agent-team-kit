"use client";

import { useEffect } from "react";

export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-zinc-200">
      <div className="max-w-lg space-y-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          Agent Team Kit
        </p>
        <h1 className="text-lg font-semibold">
          The console could not reach its backend.
        </h1>
        <p className="text-xs leading-relaxed text-zinc-400">
          Start the stack with{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5">
            bun run kit up
          </code>
          , then reload. Packs and Studio only need the filesystem, but the
          console shell waits for Postgres.
        </p>
        <p className="text-xs leading-relaxed text-zinc-400">
          控制台无法连接后端：请运行{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5">
            bun run kit up
          </code>{" "}
          后刷新。
        </p>
        {error.digest ? (
          <p className="font-mono text-[10px] text-zinc-600">
            digest {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
        >
          Try again · 重试
        </button>
      </div>
    </div>
  );
}
