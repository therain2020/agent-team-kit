import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Root-level scripts are not workspace packages, so bundler-style installs
     * have no `node_modules/@kit/*` symlinks next to them. Map the packages
     * that `scripts/*` tests import to their sources (mirrors tsconfig paths).
     * Package/subpath imports keep resolving through the workspace links.
     */
    alias: [
      {
        find: /^@kit\/core$/,
        replacement: path.join(root, "packages/core/src/index.ts"),
      },
      {
        find: /^@kit\/core\/fs-lock$/,
        replacement: path.join(root, "packages/core/src/fs-lock.ts"),
      },
      {
        find: /^@kit\/activity$/,
        replacement: path.join(root, "packages/activity/src/index.ts"),
      },
      {
        find: /^@kit\/evolution$/,
        replacement: path.join(root, "packages/evolution/src/index.ts"),
      },
      {
        find: /^@kit\/store$/,
        replacement: path.join(root, "packages/store/src/index.ts"),
      },
    ],
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.tmp/**",
      "**/.claude/**",
      "**/variants/**",
    ],
  },
});
