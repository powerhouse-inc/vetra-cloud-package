import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    globals: true,
    // Many suites build a real reactor on PGlite (licensing, apps, studio
    // pool, housekeeping). Under a full parallel run they are CPU-bound and
    // can exceed the 5 s / 10 s defaults while passing alone; the budget is
    // raised for every file instead of excluding any.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // e2e specs need a live reactor (localhost:4001) + a kubectl-connected
    // cluster, so they hang in CI/sandbox. They are run manually.
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
