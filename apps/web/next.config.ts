import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  distDir: process.env.KIT_WEB_DIST_DIR ?? ".next",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: [
    "@kit/core",
    "@kit/store",
    "@kit/model",
    "@kit/manager",
    "@kit/pack",
    "@kit/engine",
    "@kit/evolution",
    "@kit/iteration",
    "@kit/job",
    "@kit/workflow",
    "@kit/source",
  ],
  serverExternalPackages: ["postgres", "better-sqlite3", "@aws-sdk/client-s3"],
  experimental: {
    staleTimes: { dynamic: 10, static: 300 },
  },
};

export default withNextIntl(nextConfig);
