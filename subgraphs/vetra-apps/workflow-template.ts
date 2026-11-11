/**
 * `.github/workflows/vetra.yml` with the App id and production branch filled
 * in. Codegen (`ph init`) writes the same workflow with
 * `app-id: ${{ vars.VETRA_APP_ID }}`. Job `publish` runs
 * powerhouse-inc/vetra-publish on pushes to every branch and on pull
 * requests (builds everywhere, releases from release branches); job `deploy`
 * keeps the old vetra-deploy-action on the production branch and pull
 * requests until phase 2 removes that path (releases spec, section 3).
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

// A Powerhouse package builds with `ph-cli build`, and ph-cli declares
// engines.node >= 24. Setting up anything older fails the install or the build.
const NODE_VERSION = 24;

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
  // bun installs and builds, but the build still shells into ph-cli, so Node
  // has to be set up as well. `cache: bun` is not a setup-node option.
  if (manager === "bun") {
    return (
      "      - uses: oven-sh/setup-bun@v2\n" +
      `      - uses: actions/setup-node@v4\n        with: { node-version: ${NODE_VERSION} }\n`
    );
  }
  const node = `      - uses: actions/setup-node@v4\n        with: { node-version: ${NODE_VERSION}, cache: ${manager} }\n`;
  if (manager !== "pnpm") return node;
  // pnpm must be on PATH before setup-node's cache lookup runs.
  const version = declaresPackageManager
    ? ""
    : `\n        with: { version: ${DEFAULT_PNPM_VERSION} }`;
  return `      - uses: pnpm/action-setup@v4${version}\n${node}`;
}

/**
 * Pull requests from another repository never reach the OIDC token. Compare
 * full names rather than asking whether the head repo is a fork, which is
 * true for every PR when this repository is itself a fork.
 */
const SAME_REPO =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

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
  const manager =
    repo.packageManager === undefined ? "pnpm" : repo.packageManager;
  const setup = setupSteps(manager, repo.declaresPackageManager ?? false);

  // Both actions default every command to pnpm: spell them out for any other
  // manager.
  const commands =
    manager !== null && manager !== "pnpm"
      ? `          install-command: ${JSON.stringify(COMMANDS[manager].install)}\n          build-command: ${JSON.stringify(COMMANDS[manager].build)}\n`
      : "";
  // vetra-publish skips install and build when it has no package to publish;
  // the old action needs them, and publishing, turned off explicitly.
  const deployCommands =
    manager === null
      ? "          install-command: ''\n          build-command: ''\n          package-dirs: ''\n"
      : commands;
  const branchInput =
    productionBranch === "main"
      ? ""
      : `          production-branch: ${JSON.stringify(productionBranch)}\n`;

  return `name: Vetra
on:
  push:
    # Every branch publishes builds; the production branch and the App's
    # release branches also publish releases. release-please's branches only
    # carry release PRs, which run as pull requests.
    branches: ['**', '!release-please--**']
  pull_request:
    types: [opened, synchronize, reopened]
permissions: {}
concurrency:
  # A push may be cutting a release: one group per commit, so a newer push
  # never cancels it (nor a pending one). A pull request keeps only its newest run.
  group: vetra-\${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  publish:
    if: ${SAME_REPO}
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
      attestations: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
${setup}      - uses: powerhouse-inc/vetra-publish@v1
        with:
          app-id: ${appId}
${commands}  # The production environment and PR previews, until releases replace them.
  deploy:
    if: (${SAME_REPO}) && (github.event_name == 'pull_request' || github.ref == 'refs/heads/${productionBranch}') && !startsWith(github.head_ref, 'release-please--')
    # Deploys go out in order: a newer push or PR commit supersedes a running one.
    concurrency:
      group: vetra-deploy-\${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
${setup}      - uses: powerhouse-inc/vetra-deploy-action@v1
        with:
          app-id: ${appId}
${deployCommands}${branchInput}`;
}
