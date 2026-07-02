import { defineConfig, configDefaults } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    globals: true,
    // e2e specs need a live reactor (localhost:4001) + a kubectl-connected
    // cluster; they hang in CI/sandbox. Keep them out of `vitest run` (they're
    // run manually). The 6.2 migration's config dropped this exclude.
    exclude: [...configDefaults.exclude, "**/e2e*", "**/*.e2e.test.ts"],
    coverage: {
      provider: "v8",
      include: ["document-models/**/src/reducers/**"],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
  plugins: [tsconfigPaths()],
});
