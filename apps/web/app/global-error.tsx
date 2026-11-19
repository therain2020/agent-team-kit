"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: "48px 24px",
          background: "#070b13",
          color: "#dbe4ee",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: 640, margin: "0 auto" }}>
          <p
            style={{
              fontFamily: "monospace",
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#8492a8",
            }}
          >
            Agent Team Kit
          </p>
          <h1 style={{ fontSize: 20, margin: "12px 0" }}>
            The console failed to render.
          </h1>
          <p style={{ fontSize: 13, color: "#a7b4c8" }}>
            控制台渲染失败。请运行{" "}
            <code style={{ background: "#101a2b", padding: "2px 6px" }}>
              bun run kit up
            </code>{" "}
            后刷新页面；如果问题持续，请附上下面的 digest 提交 issue。
          </p>
          <p style={{ fontSize: 13, color: "#a7b4c8" }}>
            Start the stack with{" "}
            <code style={{ background: "#101a2b", padding: "2px 6px" }}>
              bun run kit up
            </code>
            , then reload. Include the digest below in a bug report if it
            persists.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 11, color: "#6d7c93" }}>
              digest {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "6px 12px",
              borderRadius: 0,
              border: "1px solid #2b3a55",
              boxShadow: "2px 2px 0 #020409",
              background: "#101a2b",
              color: "#dbe4ee",
              cursor: "pointer",
            }}
          >
            Try again · 重试
          </button>
        </main>
      </body>
    </html>
  );
}
