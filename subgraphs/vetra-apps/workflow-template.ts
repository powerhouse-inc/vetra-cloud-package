/**
 * `.github/workflows/vetra.yml` (contract C4) with the App id and production
 * branch filled in. Codegen (`ph init`) writes the same workflow with
 * `app-id: ${{ vars.VETRA_APP_ID }}`.
 */

/** Package managers we can set up in the generated workflow. */
export type PackageManager = "pnpm" | "bun" | "npm" | "yarn";

/** Lockfile each manager leaves at the repository root, most specific first. */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * pnpm/action-setup reads its version from package.json's `packageManager` and
 * fails with "No pnpm version is specified" when that field is absent. Passing
 * a version that disagrees with the field is also an error, so we only pass one
 * when the repository does not declare it.
 */
const DEFAULT_PNPM_VERSION = "10";

const NODE_VERSION = 22;

/** The commands vetra-deploy-action defaults to; only emitted when they differ. */
const COMMANDS: Record<PackageManager, { install: string; build: string }> = {
  pnpm: { install: "pnpm install --frozen-lockfile", build: "pnpm build" },
  bun: { install: "bun install --frozen-lockfile", build: "bun run build" },
  yarn: { install: "yarn install --frozen-lockfile", build: "yarn build" },
  npm: { install: "npm ci", build: "npm run build" },
};

function setupSteps(
  manager: PackageManager | null,
  declaresPackageManager: boolean,
): string {
  if (manager === null) return "";
  if (manager === "bun") {
    return "      - uses: oven-sh/setup-bun@v2\n";
  }
  const node = `      - uses: actions/setup-node@v4\n        with: { node-version: ${NODE_VERSION}, cache: ${manager} }\n`;
  if (manager !== "pnpm") return node;
  // pnpm must be on PATH before setup-node's cache lookup runs.
  const version = declaresPackageManager
    ? ""
    : `\n        with: { version: ${DEFAULT_PNPM_VERSION} }`;
  return `      - uses: pnpm/action-setup@v4${version}\n${node}`;
}

export function workflowTemplate(
  appId: string,
  productionBranch = "main",
  repo: {
    /** Detected from the repository's lockfile; null when it ships no package.json. */
    packageManager?: PackageManager | null;
    /** Whether package.json carries a `packageManager` field. */
    declaresPackageManager?: boolean;
  } = {},
): string {
  const manager = repo.packageManager === undefined ? "pnpm" : repo.packageManager;
  const branchInput =
    productionBranch === "main"
      ? ""
      : `          production-branch: ${JSON.stringify(productionBranch)}\n`;
  const branchList =
    productionBranch === "main" ? "main" : JSON.stringify(productionBranch);

  // vetra-deploy-action defaults every command to pnpm. Spell them out for any
  // other manager, and disable them entirely when there is nothing to install.
  const commandInputs =
    manager === null
      ? "          install-command: ''\n          build-command: ''\n          package-dirs: ''\n"
      : manager === "pnpm"
        ? ""
        : `          install-command: ${JSON.stringify(COMMANDS[manager].install)}\n          build-command: ${JSON.stringify(COMMANDS[manager].build)}\n`;

  return `name: Vetra
on:
  push:
    branches: [${branchList}]
    tags: ["v*"]
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  id-token: write
  contents: read
concurrency:
  group: vetra-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  deploy:
    # Skip pull requests opened from another repository: they must not reach the
    # OIDC token. Compare full names rather than asking whether the head repo is
    # a fork, which is true for every PR when this repository is itself a fork.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupSteps(manager, repo.declaresPackageManager ?? false)}      - uses: powerhouse-inc/vetra-deploy-action@v1
        with:
          app-id: ${appId}
${commandInputs}${branchInput}`;
}
