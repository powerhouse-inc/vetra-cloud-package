/**
 * `.github/workflows/vetra.yml` (contract C4) with the App id and production
 * branch filled in. Codegen (`ph init`) writes the same workflow with
 * `app-id: ${{ vars.VETRA_APP_ID }}`.
 */
export function workflowTemplate(
  appId: string,
  productionBranch = "main",
): string {
  const branchInput =
    productionBranch === "main"
      ? ""
      : `          production-branch: ${JSON.stringify(productionBranch)}\n`;
  const branchList =
    productionBranch === "main" ? "main" : JSON.stringify(productionBranch);
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
    if: github.event.pull_request.head.repo.fork != true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: powerhouse-inc/vetra-deploy-action@v1
        with:
          app-id: ${appId}
${branchInput}`;
}
