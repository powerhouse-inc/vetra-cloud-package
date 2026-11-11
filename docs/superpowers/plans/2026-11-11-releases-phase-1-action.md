# Releases phase 1 (the vetra-publish action) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Action, `powerhouse-inc/vetra-publish@v1`, that on every push and same-repo pull request versions the run (release-please release PRs, build versions), builds and pushes the app's host image to `cr.vetra.io`, attests it, publishes the app's npm packages at the same version and reports it with `POST ci/releases`; plus the two server pieces it needs (`POST ci/github-token`, the new generated `vetra.yml`).

**Architecture:** A new public repo `powerhouse-inc/vetra-publish` holding a composite action. Its logic is plain ESM JavaScript in small, separately tested modules (`node --test`, no network in tests), bundled with `@vercel/ncc` into three committed entry points: `dist/prepare` (decide release or build and the version, keep the release PR current as the Vetra GitHub App, build and push the image), `dist/finish` (publish packages, report) and `dist/check` (the local `vetra-publish check` CLI, spec 14.10). Between the two node steps the composite runs `actions/attest-build-provenance`, so the attestation is signed by the caller's own `vetra.yml`. In vetra-cloud-package, a new CI route hands a release-branch push run the Vetra GitHub App's installation token, and the generated workflow gets a `publish` job next to the old `deploy` job.

**Tech Stack:** Node 24 (runtime ≥ 20), `release-please@17.11.2` (as a library), `@vercel/ncc@0.45.0`, Docker CLI on `ubuntu-latest`, `actions/attest-build-provenance@v2`, GitHub REST API; server side TypeScript, vitest, Kysely (as plan 1).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (sections 3, 14.1, 14.10, 14.11, 14.17, 15, 18 phase 1) and its spike findings `docs/superpowers/specs/2026-11-11-releases-phase-1-spike.md`; Renown release branches: renown-package `docs/superpowers/specs/2026-11-11-workload-release-branches-design.md` (sections 3-5, 7). Server contract as built: `subgraphs/vetra-apps/ci.ts` (`parseReleaseBody`), `subgraphs/vetra-apps/releases/*.ts`. Reference run that passed on production (Sektar, 2026-11-11): the hand-written `vetra.yml` (OIDC → Renown, `ci/registry-token`, `docker build`/`push`, `actions/attest-build-provenance@v2`, `ci/releases`).

## Global Constraints

- The workflow file is `.github/workflows/vetra.yml`, and the action is a composite (not a reusable workflow): Vetra checks the attestation's SAN `https://github.com/<repo>/.github/workflows/vetra.yml@…`.
- Image: `cr.vetra.io/<repository>:<version>`, `<repository>` exactly as `POST ci/registry-token` returns it (`<namespace>/<app>`). Tags are written once and never moved; Vetra records the digest.
- Version rule (verbatim from `releases/version.ts`): every version is semver; a **release** has no prerelease part or one matching exactly `^(alpha|beta|rc)\.\d+$`; anything else is a **build**.
- Build versions: `<proposed>-<branch>.<run_number>` on a push, `<proposed>-pr.<n>.<run_number>` on a pull request; `<proposed>` is what the target branch's release PR proposes.
- `POST ci/releases` body is exactly what `parseReleaseBody` reads: `packages` is a required array of `{name, version}`; `pr` an integer or `null`; `branch` `null` for a PR; `notes` a string or `null`; `requires` only `powerhouse` (string), `services` (string list), `size` (string); `migrates` boolean; `built.powerhouse` and `built.baseImage` non-empty strings. Wrong types are refused, never coerced.
- `commit` is `GITHUB_SHA` (for a PR, the merge commit): it must equal the token's `claim.sha` and the attestation's `gitCommit`.
- Vetra takes a `release` only from a `push` to the production branch or a listed release branch whose token says `releaseBranch: true`; builds from any `push` or `pull_request`. `workflow_dispatch` and tag runs report nothing.
- Renown: GitHub OIDC audience `https://renown.vetra.io`, exchange at `<renown-url>/api/@powerhousedao/renown-package/workload/token`; Vetra audience `https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps`; npm registry audiences `https://registry.vetra.io` (production branch and release branches only) and `https://registry.dev.vetra.io` (every other branch and PRs). Tokens live 600 s: re-mint every 5 minutes.
- Release PRs, tags and GitHub releases are made with the Vetra GitHub App's installation token, never the workflow's `GITHUB_TOKEN` (spec 14.1).
- The action deploys nothing.
- Fork pull requests never reach the OIDC token (`head.repo.full_name == github.repository` guard).
- Action unit tests run offline (`node --test`), with injected `fetch`/`exec`.
- Git: work on `feat/…`/`fix/…`/`docs/…` branches, never on `main`; one logical change per commit; every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (with reasons)

| Decision | Reason |
|---|---|
| New repo `powerhouse-inc/vetra-publish`, not a v2 of `vetra-deploy-action` | Spec section 3 names `powerhouse-inc/vetra-publish@v1`, and phase 1 runs both actions side by side; the old one stays untouched until phase 2 deprecates it. |
| Composite action whose logic is ncc-bundled JS | Only a composite can call `actions/attest-build-provenance` as a step, and its steps run inside the caller's `vetra.yml`, so the attestation's SAN names that file (a reusable workflow would sign as the action repo's workflow). Bundling: release-please is a library with many dependencies and template files; ncc copies them (checked: the `.hbs` changelog templates land next to `index.js`). |
| release-please used as a library (`Manifest.fromConfig`), no `release-please-config.json` in app repos | The action computes the config per branch (production, prerelease, maintenance) and needs the proposed version for builds (`buildPullRequests()`), which the CLI and `release-please-action` do not expose. Tags stay plain `v<version>` (`includeComponentInTag: false`), so Sektar's existing `v1.0.9` tag is found as the last release. |
| `versioning: "prerelease"` on every release branch; `prerelease: true, prereleaseType: "<id>.0"` on prerelease branches | Checked in release-please 17.11.2: with `prereleaseType: "beta"` it proposes `2.0.0-beta` (a build under Vetra's rule), with `"beta.0"` it proposes `2.0.0-beta.0`, then `beta.1`… On `main` the default strategy would turn `2.0.0-beta.3` + `feat` into `2.1.0-beta.3`; the prerelease strategy with `prerelease: false` gives `2.0.0`. |
| Which branch is a release branch comes from the workload token's `vetra.releaseBranch` (decoded, unverified) | Vetra's `releaseBranches` setting is the source of truth and Renown already stamps it on the token; the action only uses it to decide what to try, Vetra re-checks everything. |
| New server route `POST ci/github-token` (installation token: one repo, `contents: write`, `pull_requests: write`, release-branch pushes only) | 14.1 requires acting as the Vetra GitHub App and only Vetra holds its key; the release-branch rule is the one `ci/releases` already enforces for releases. |
| Builds read release history with the run's own `GITHUB_TOKEN` | A PR or feature-branch run needs read access only; no App token is handed to code that is not on a release branch. |
| npm packages: published by the action at the run's version, `package.json` versions stamped locally (never committed, as the old action); production registry only when `releaseBranch` | Same version for image and packages (section 3 step 4); Renown refuses the production registry audience elsewhere. Root `package.json` is the one release-please bumps in the release PR. |
| dist-tags: releases `latest` (production branch), `latest-<major>` (maintenance), `next` (prereleases); builds `<branch>` or `pr-<n>`, with `branch-` prepended when the branch is `latest`/`next`/`latest-N` or starts like a semver range | A `1.x` release must not move `latest` back; npm refuses tags that parse as ranges (`1.x`); a branch called `next` must not overwrite the prerelease tag. Written back into the spec. |
| Generated `vetra.yml`: push on all branches except `release-please--**`, plus `pull_request`; no tag trigger; `cancel-in-progress` only for PRs; two jobs in phase 1: `publish` (new) and `deploy` (old action, production branch and PRs only) | Safe now: Renown issues `BRANCH` tokens and Vetra refuses releases from other branches. Release PR branches would only produce duplicate builds. Tags are created by the App and would start a second run. Cancelling a push could stop a run between tagging and reporting. The old deploy path still runs the production environment and previews until phase 2. |
| Switch-over: opt-in. New apps get the two-job workflow; existing apps get it through the existing setup PR (`openAppSetupPullRequest`, now on branch `vetra/publish`); `vetra-deploy-action@v1` is not changed | Spec section 3: "repos opt into vetra-publish (both may run side by side)"; a new branch name avoids reusing a stale `vetra/setup` branch. Sektar gets a hand-made variant (Task 15) because its licensed environments still follow the old tag-built host image until phase 3. |
| A re-run of a failed release run re-reports the release | Detected by a GitHub release whose `target_commitish` is this commit; an existing image tag is reused (digest read from the registry), so `ci/releases` answers 200 (same digest) instead of 409. |

## Deferred (not in this plan)

- `ph vetra check` as a `ph` command and the `vetra` keys in Powerhouse's `source-config.schema` (powerhouse monorepo; needs its own small plan). Phase 1 ships the same check as `npx -y github:powerhouse-inc/vetra-publish#v1 check` (Task 14). Until the schema lists the new keys, editors flag them; `ph` does not validate the file at runtime.
- SBOM attestation (`actions/attest-sbom`): Vetra reads no SBOM in phase 1; scans arrive in phase 4.
- Build cache, more than one host image per app (`<app>-<host>`), the smoke test (`vetra.smoke`, phase 5).
- Old action deprecation, PR comment/check, PR-title check (14.18), build pruning: phase 2.
- Vetra opening a PR that adds `hosts/cli` (14.11, second half).
- Server: binding the attestation SAN to the ref and run id (spike section 3, deferred there).
- `workflow_dispatch` runs (Vetra refuses their reports today).
- Upgrading `actions/attest-build-provenance` past v2 (v2 is what passed end to end).
- A console entry point for the switch-over PR of existing apps (plan 3, console).

## Needs the user

1. Create the public repo `powerhouse-inc/vetra-publish` with a `main` branch (Task 3), and later approve the `v1.0.0`/`v1` tags (Task 15).
2. GitHub App "Vetra Deploy": add `contents: write` and `pull_requests: write` (with `attestations: read` from plan 1) and have each installation that publishes approve them (spec 15).
3. Deploy vetra-cloud-package with Tasks 1-2 (release + `powerhouse-k8s-hosting` version pin).
4. A canary repo and Vetra App for the end-to-end release test (Task 15), and the go-ahead for Sektar's workflow PR (not before Sektar's v1.0.9 rollout window, 2026-11-13 18:41 UTC).

## File structure

vetra-cloud-package (this repo):

| File | Responsibility |
|---|---|
| `subgraphs/vetra-apps/github.ts` | `createReleaseToken(installationId, repositoryId)` |
| `subgraphs/vetra-apps/releases/claim.ts` | `assertReleaseBranchPush(app, claim)` |
| `subgraphs/vetra-apps/releases/service.ts` | `ciGithubToken(deps, ci, appId)` |
| `subgraphs/vetra-apps/ci.ts`, `index.ts` | the `apps/ci/github-token` route |
| `subgraphs/vetra-apps/workflow-template.ts` | the generated `vetra.yml` (publish + deploy jobs) |
| `subgraphs/vetra-apps/service.ts` | setup PR branch and text |
| `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` | write-back of this plan's decisions |

powerhouse-inc/vetra-publish (new, cloned at `/home/froid/projects/vetra-publish`):

| File | Responsibility |
|---|---|
| `action.yml` | composite: prepare → attest → install/build → finish → logout |
| `src/util.js`, `fetch-retry.js`, `oidc.js`, `exchange.js`, `token-source.js`, `rest.js`, `publish.js` | ported verbatim from `vetra-deploy-action@87328cf` |
| `src/version.js` | version rules, build versions, fallback proposal |
| `src/config.js` | `vetra` section of `powerhouse.config.json`, host Dockerfile |
| `src/run-context.js` | what the run is (event, branch, PR, target branch); `parseRemote` |
| `src/claim.js` | the workload token's `vetra` claim (unverified) |
| `src/inputs.js` | action inputs; state handed from prepare to finish |
| `src/tokens.js` | Renown token source per audience |
| `src/release-please.js` | release-please config, proposed version, cutting releases |
| `src/decide.js` | release or build, and the version |
| `src/dockerfile.js` | base image of a Dockerfile's final stage |
| `src/image.js` | registry login, build/reuse, push, digest, Powerhouse version, base image digest |
| `src/packages.js` | registry and dist-tag rules, publishing |
| `src/migrates.js` | does a release migrate |
| `src/vetra-api.js` | `ci/registry-token`, `ci/github-token`, `ci/releases` |
| `src/report.js` | the `ci/releases` body and job summary |
| `src/prepare.js`, `src/finish.js`, `src/check.js` | entry points |
| `scripts/build.js` | ncc bundles into `dist/` |
| `test/*.test.js` | one per module |

---

### Task 1: Server — `POST apps/ci/github-token` (spec 14.1), and the spec write-back

**Files:**
- Modify: `subgraphs/vetra-apps/github.ts` (interface next to `createRepoPushToken` ~line 170; implementation ~line 663)
- Modify: `subgraphs/vetra-apps/__tests__/harness.ts` (`fakeGithub`, next to `createRepoPushToken` ~line 345)
- Modify: `subgraphs/vetra-apps/releases/claim.ts`
- Modify: `subgraphs/vetra-apps/releases/service.ts`
- Modify: `subgraphs/vetra-apps/ci.ts` (doc comment ~line 34, routes ~line 340)
- Modify: `subgraphs/vetra-apps/index.ts` (~line 278)
- Modify: `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`
- Test: `subgraphs/vetra-apps/__tests__/github.test.ts`, `subgraphs/vetra-apps/__tests__/releases-github-token.test.ts` (new), `subgraphs/vetra-apps/__tests__/ci.test.ts`, `subgraphs/vetra-apps/__tests__/subgraph.test.ts`

**Interfaces:**
- Produces: `POST /api/@powerhousedao/vetra-cloud-package/apps/ci/github-token` with body `{ "appId": "…" }` → 200 `{ "token": "ghs_…", "expiresAt": "<ISO>" }`; 403 `FORBIDDEN` unless the token is a `push` on the production branch or a listed release branch that Renown marked `releaseBranch`; 503 `SERVICE_UNAVAILABLE` when GitHub refuses the token. The action (Task 12) calls it.
- Produces: `GithubDeployApi.createReleaseToken(installationId: string, repositoryId: string): Promise<{ token: string; expiresAt: string }>`; `assertReleaseBranchPush(app, claim): string` (the branch); `ciGithubToken(deps, ci, appId): Promise<{ token: string; expiresAt: string }>`.

- [ ] **Step 1: Branch**

```bash
cd /home/froid/projects/vetra-cloud-package
git fetch -q origin && git switch -c feat/ci-github-token origin/main
```

- [ ] **Step 2: Write the failing GitHub client test**

Append inside `describe("GitHub deploy client", …)` in `subgraphs/vetra-apps/__tests__/github.test.ts`:

```ts
  it("mints a release token: one repository, contents and pull_requests write", async () => {
    const f = fakeFetch({
      "POST /app/installations/77/access_tokens": () =>
        Response.json({ token: "ghs_rel", expires_at: "2026-11-11T13:00:00Z" }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(await gh.createReleaseToken("77", "4242")).toStrictEqual({
      token: "ghs_rel",
      expiresAt: "2026-11-11T13:00:00Z",
    });
    expect(f.calls[0].body).toStrictEqual({
      repository_ids: [4242],
      permissions: { contents: "write", pull_requests: "write" },
    });
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/github.test.ts -t "release token"`
Expected: FAIL, `gh.createReleaseToken is not a function`.

- [ ] **Step 4: Implement `createReleaseToken`**

In `subgraphs/vetra-apps/github.ts`, add to the `GithubDeployApi` interface, right after `createRepoPushToken(…)`:

```ts
  /**
   * An installation token limited to one repository with contents:write and
   * pull_requests:write (POST /app/installations/{id}/access_tokens, app JWT):
   * what vetra-publish needs to open release PRs and tag releases (spec 14.1).
   * GitHub refuses it until the installation has approved both permissions.
   * One hour. Never log the token.
   */
  createReleaseToken(
    installationId: string,
    repositoryId: string,
  ): Promise<{ token: string; expiresAt: string }>;
```

In `createGithubDeployApi`, add this local function right after `async function installationToken(…) { … }`:

```ts
  /** A one-repository installation token with exactly `permissions`. */
  async function repoAccessToken(
    installationId: string,
    repositoryId: string,
    permissions: Record<string, "read" | "write">,
  ): Promise<{ token: string; expiresAt: string }> {
    const { token: jwt } = await auth({ type: "app" });
    const id = Number(repositoryId);
    if (!Number.isSafeInteger(id))
      throw new GithubHttpError(400, "invalid repository id");
    const { data } = await call<{ token?: string; expires_at?: string } | null>(
      jwt,
      "POST",
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { repository_ids: [id], permissions },
      [],
      "Bearer",
    );
    if (!data?.token || !data.expires_at)
      throw new GithubHttpError(502, "GitHub returned no installation token");
    return { token: data.token, expiresAt: data.expires_at };
  }
```

Replace the body of the existing `async createRepoPushToken(installationId, repositoryId) { … }` in the returned object with a call to it, and add `createReleaseToken` after it:

```ts
    async createRepoPushToken(installationId, repositoryId) {
      return repoAccessToken(installationId, repositoryId, { contents: "write" });
    },

    async createReleaseToken(installationId, repositoryId) {
      return repoAccessToken(installationId, repositoryId, {
        contents: "write",
        pull_requests: "write",
      });
    },
```

In `subgraphs/vetra-apps/__tests__/harness.ts`, add to `fakeGithub()`'s returned object after `createRepoPushToken: rec(…)`:

```ts
    createReleaseToken: rec("createReleaseToken", () => ({
      token: "ghs_release",
      expiresAt: "2026-10-02T13:00:00.000Z",
    })),
```

- [ ] **Step 5: Run the GitHub client tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/github.test.ts`
Expected: PASS (the existing push-token test still passes).

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/github.ts subgraphs/vetra-apps/__tests__/github.test.ts subgraphs/vetra-apps/__tests__/harness.ts
git commit -m "feat(apps): GitHub release token (contents and pull_requests write)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing service tests**

Create `subgraphs/vetra-apps/__tests__/releases-github-token.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciIdentity,
  claim,
  INSTALLATION,
  makeHarness,
  owner,
  REPO_ID,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciGithubToken } from "../releases/service.js";
import { updateApp } from "../service.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

describe("ciGithubToken (spec 14.1)", () => {
  it("mints the release token for a push to the production branch", async () => {
    const app = await seedActiveApp(h);
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    expect(await ciGithubToken(h.deps, ci, app.id)).toStrictEqual({
      token: "ghs_release",
      expiresAt: "2026-10-02T13:00:00.000Z",
    });
    expect(h.github.calls.createReleaseToken).toStrictEqual([
      [INSTALLATION, REPO_ID],
    ]);
  });

  it("a listed release branch gets one when Renown marks it too", async () => {
    const app = await seedActiveApp(h);
    await updateApp(h.deps, owner, app.id, { releaseBranches: ["next"] });
    const ci = ciIdentity(
      claim("refs/heads/next", { refClass: "BRANCH", releaseBranch: true }),
    );
    await expect(ciGithubToken(h.deps, ci, app.id)).resolves.toMatchObject({
      token: "ghs_release",
    });
  });

  it("refuses PRs, dispatches, other branches, unmarked branches and other repositories", async () => {
    const app = await seedActiveApp(h);
    await updateApp(h.deps, owner, app.id, { releaseBranches: ["next"] });
    for (const c of [
      claim("refs/pull/3/merge"),
      claim("refs/heads/main", { eventName: "workflow_dispatch" }),
      claim("refs/heads/feature", { refClass: "BRANCH", releaseBranch: false }),
      claim("refs/heads/next", { refClass: "BRANCH", releaseBranch: false }),
      claim("refs/heads/main", { releaseBranch: false }),
      claim("refs/heads/main", { repositoryId: "9999" }),
    ]) {
      await expect(
        ciGithubToken(h.deps, ciIdentity(c), app.id),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    expect(h.github.calls.createReleaseToken).toBeUndefined();
  });

  it("GitHub refusing the token is a 503 that names the permissions", async () => {
    const app = await seedActiveApp(h);
    h.deps.github!.createReleaseToken = async () => {
      throw new Error("github: POST access_tokens → 422");
    };
    await expect(
      ciGithubToken(h.deps, ciIdentity(claim("refs/heads/main")), app.id),
    ).rejects.toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
      message: expect.stringMatching(/pull_requests: write/),
    });
  });
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-github-token.test.ts`
Expected: FAIL, `ciGithubToken` is not exported.

- [ ] **Step 9: Implement the claim check and the service**

Append to `subgraphs/vetra-apps/releases/claim.ts`:

```ts
/**
 * A push run on the production branch or one of the app's release branches
 * that Renown also marked as a release branch (the same rule as a reported
 * release). Returns the branch.
 */
export function assertReleaseBranchPush(
  app: {
    repository_id: string | null;
    production_branch: string;
    release_branches?: string | null;
  },
  verified: VetraClaim | null,
): string {
  const claim = assertClaimForApp(app, verified);
  const m = /^refs\/heads\/(.+)$/.exec(claim.ref);
  if (claim.eventName !== "push" || !m)
    throw appsError(
      "FORBIDDEN",
      `Only a push to a release branch acts as the Vetra GitHub App (got ${claim.eventName ?? "?"} on ${claim.ref})`,
    );
  const branch = m[1];
  if (
    !isReleaseBranch(
      branch,
      app.production_branch,
      parseReleaseBranches(app.release_branches),
    )
  )
    throw appsError(
      "FORBIDDEN",
      `${branch} is not a release branch of this app: only ${app.production_branch} and the app's release branches open release PRs`,
    );
  if (!renownSaysReleaseBranch(claim, branch, app.production_branch))
    throw appsError(
      "FORBIDDEN",
      `Renown did not mark ${branch} as a release branch for this token`,
    );
  return branch;
}
```

In `subgraphs/vetra-apps/releases/service.ts`, change the claim import to:

```ts
import {
  assertClaimForApp,
  assertReleaseBranchPush,
  assertReportAllowed,
} from "./claim.js";
```

and add after `ciRegistryToken`:

```ts
/**
 * The Vetra GitHub App's installation token for one release-branch push run
 * (spec 14.1): one repository, contents and pull_requests write, one hour.
 * vetra-publish opens the release PR and tags releases with it, so GitHub
 * starts workflows for them (it does not for GITHUB_TOKEN).
 */
export async function ciGithubToken(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
): Promise<{ token: string; expiresAt: string }> {
  const app = await upstream(deps, RENOWN_DOWN, () =>
    authorizeCi(deps, ci, appId),
  );
  assertReleaseBranchPush(app, ci.claim);
  const github = deps.github;
  if (!github) throw notConfigured("The Vetra Deploy GitHub App");
  if (!app.installation_id || !app.repository_id)
    throw appsError("BAD_USER_INPUT", "This App has no GitHub repository");
  try {
    return await github.createReleaseToken(
      app.installation_id,
      app.repository_id,
    );
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] release token for ${app.slug}: ${String(err)}`,
    );
    throw appsError(
      "SERVICE_UNAVAILABLE",
      "Could not mint the GitHub installation token for release PRs and tags (the Vetra GitHub App's installation must approve contents: write and pull_requests: write); retry",
    );
  }
}
```

- [ ] **Step 10: Run the service tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-github-token.test.ts subgraphs/vetra-apps/__tests__/releases-claim.test.ts`
Expected: PASS.

- [ ] **Step 11: Write the failing route tests**

In `subgraphs/vetra-apps/__tests__/ci.test.ts`, inside `describe("release routes: upstream failures are 503", …)`, add after the `report` helper:

```ts
  const githubToken = (c: unknown = prodClaim) =>
    createCiRoutes(h.deps, fakeVerifier).githubToken(
      post("apps/ci/github-token", bearer(c), { appId: app.id }),
    );

  it("github-token: a production push gets the token", async () => {
    const res = await githubToken();
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      token: "ghs_release",
      expiresAt: "2026-10-02T13:00:00.000Z",
    });
  });

  it("github-token: a pull request is refused, GitHub failing is a 503", async () => {
    expect((await githubToken(prClaim(4))).status).toBe(403);
    h.deps.github!.createReleaseToken = async () => {
      throw new Error("422");
    };
    expect(await answer(githubToken())).toMatchObject({
      status: 503,
      error: "SERVICE_UNAVAILABLE",
    });
  });
```

In `subgraphs/vetra-apps/__tests__/subgraph.test.ts`, add to the expected route list right after the `"apps/ci/releases"` entry:

```ts
      [
        "POST",
        "apps/ci/github-token",
        { auth: "public", maxBodyBytes: 256 * 1024 },
      ],
```

- [ ] **Step 12: Run them to verify they fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/ci.test.ts subgraphs/vetra-apps/__tests__/subgraph.test.ts`
Expected: FAIL (`githubToken` is not a function; route list differs).

- [ ] **Step 13: Add the route**

In `subgraphs/vetra-apps/ci.ts`: add ` *   POST apps/ci/github-token          {appId}` to the doc comment after the `registry-token` line; extend the releases import to `ciGithubToken, ciRegistryToken, ciReportRelease, type ReportReleaseInput`; add to the object returned by `createCiRoutes`, after `releases`:

```ts
    githubToken: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        return ciGithubToken(deps, ci, requireString(body, "appId"));
      }),
```

In `subgraphs/vetra-apps/index.ts`, after the `apps/ci/releases` route:

```ts
        this.http.post("apps/ci/github-token", json, (request) =>
          ci.githubToken(request),
        ),
```

- [ ] **Step 14: Run the whole vetra-apps suite and the type check**

Run: `npx vitest run subgraphs/vetra-apps 2>&1 | tail -15 && npx tsc --noEmit -p . 2>&1 | tail -5`
Expected: all tests PASS; no type errors.

- [ ] **Step 15: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(releases): POST ci/github-token for release-branch pushes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 16: Write the plan's decisions back into the spec**

In `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`, insert before `### \`POST ci/releases\``:

```markdown
### `POST ci/github-token`

`{ "appId": "…" }` → `{ "token": "ghs_…", "expiresAt": "…" }`: the Vetra
GitHub App's installation token for the app's repository only, with
`contents: write` and `pull_requests: write`, valid one hour (14.1). Issued
only to a `push` run on the production branch or a listed release branch
whose token carries `releaseBranch: true` (the rule `ci/releases` applies to
releases), else `FORBIDDEN`; 503 while the installation has not approved the
permissions. The action uses it for the release PR, the tag and the GitHub
release, and the run's own `GITHUB_TOKEN` for reading history.
```

and append after the numbered "One run" list (after step 5, "Report"):

```markdown
Details fixed by the action (plan 2):

- The `vetra` section keys the action reads: `host` (default `cli`; image
  built from `hosts/<host>/Dockerfile`), `packageDirs` (default `["."]`),
  `prerelease` (branch → `alpha` | `beta` | `rc`), `requires`, `migrations`,
  `migrates`. Other keys there (`connectPort`, …) belong to `ph vetra`.
- dist-tags: releases `latest` from the production branch, `latest-<major>`
  from other release branches (a `1.x` patch must not move `latest`), `next`
  for prereleases; builds `<branch>` or `pr-<n>`, as `branch-<branch>` when
  the name is `latest`, `next`, `latest-<n>` or starts like a version.
- A push to a branch that is not a release branch builds `<proposed>` from
  its own history; a PR uses its target branch's proposal.
- The workflow runs on pushes to all branches except `release-please--**`
  and on PRs, never on tags (the App's tags would start a second run), and
  cancels in-progress runs only for PRs. Until phase 2 it has a second job
  running `vetra-deploy-action@v1` on the production branch and PRs.
- Finishing a prerelease line: the commit that brings `next` into `main` must
  be a conventional commit (e.g. `feat!: 2.0`), or carry `Release-As: 2.0.0`;
  a merge commit alone proposes nothing. Changing a branch's prerelease
  identifier takes effect with a `Release-As: 2.0.0-rc.0` commit.
- The SBOM attestation is deferred: Vetra reads none in phase 1.
```

- [ ] **Step 17: Commit**

```bash
git add docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md
git commit -m "docs(spec): ci/github-token and the action's details (plan 2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server — the generated `vetra.yml` gets the publish job

**Files:**
- Modify: `subgraphs/vetra-apps/workflow-template.ts` (doc comment and `workflowTemplate`)
- Modify: `subgraphs/vetra-apps/service.ts` (`openAppSetupPullRequest`, ~line 3070)
- Test: `subgraphs/vetra-apps/__tests__/resolvers.test.ts` (`describe("workflow template")`), `subgraphs/vetra-apps/__tests__/apps.test.ts` (~line 615)

**Interfaces:**
- Consumes: `powerhouse-inc/vetra-publish@v1` inputs `app-id`, `install-command`, `build-command` (Task 13).
- Produces: `workflowTemplate(appId, productionBranch = "main", repo = {})` returning the two-job workflow below (same signature as today).

- [ ] **Step 1: Branch**

```bash
cd /home/froid/projects/vetra-cloud-package
git switch -c feat/publish-workflow origin/main
```

- [ ] **Step 2: Write the failing template tests**

In `subgraphs/vetra-apps/__tests__/resolvers.test.ts`, replace the test `"runs on pushes to every branch, v* tags and pull requests"` with:

```ts
  // Every branch publishes builds, release branches also releases (Renown
  // spec 2026-11-11-workload-release-branches-design §7). No tag trigger:
  // the Vetra GitHub App creates the release tags, which would start a run.
  it("runs on pushes to every branch but release-please's, and on pull requests", () => {
    for (const t of [
      workflowTemplate("app-1"),
      workflowTemplate("app-1", "release"),
    ]) {
      expect(t).toContain(
        `on:\n  push:\n    # Every branch`,
      );
      expect(t).toContain("    branches: ['**', '!release-please--**']\n");
      expect(t).toContain("  pull_request:\n    types: [opened, synchronize, reopened]\n");
      expect(t).not.toContain("tags:");
    }
  });

  it("publishes with vetra-publish: OIDC, full history, attestations, no cancelled pushes", () => {
    const t = workflowTemplate("app-1");
    expect(t).toContain("- uses: powerhouse-inc/vetra-publish@v1\n        with:\n          app-id: app-1\n");
    expect(t).toContain("      attestations: write\n");
    expect(t).toContain("      pull-requests: read\n");
    expect(t).toContain("with: { fetch-depth: 0 }");
    expect(t).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("keeps the old deploy job, on the production branch and pull requests only", () => {
    const t = workflowTemplate("app-1", "release");
    expect(t).toContain("- uses: powerhouse-inc/vetra-deploy-action@v1");
    expect(t).toContain(
      "(github.event_name == 'pull_request' || github.ref == 'refs/heads/release')",
    );
    expect(t).toContain('production-branch: "release"');
  });
```

and in the test `"skips setup and every command when the repo has no package.json"`, add:

```ts
    // vetra-publish skips install/build itself when there is nothing to publish.
    expect(t.split("vetra-publish@v1")[1].split("deploy:")[0]).not.toContain(
      "install-command",
    );
```

In `subgraphs/vetra-apps/__tests__/apps.test.ts`, test `"opens the setup PR with the workflow for this App"`: change the expected branch `"vetra/setup"` to `"vetra/publish"` and add:

```ts
    expect(input.content).toContain("powerhouse-inc/vetra-publish@v1");
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/resolvers.test.ts subgraphs/vetra-apps/__tests__/apps.test.ts -t "workflow|setup PR"`
Expected: FAIL (no `vetra-publish@v1`, branch `vetra/setup`).

- [ ] **Step 4: Rewrite `workflowTemplate`**

In `subgraphs/vetra-apps/workflow-template.ts`, replace the file's first doc comment with:

```ts
/**
 * `.github/workflows/vetra.yml` with the App id and production branch filled
 * in. Codegen (`ph init`) writes the same workflow with
 * `app-id: ${{ vars.VETRA_APP_ID }}`. Job `publish` runs
 * powerhouse-inc/vetra-publish on pushes to every branch and on pull
 * requests (builds everywhere, releases from release branches); job `deploy`
 * keeps the old vetra-deploy-action on the production branch and pull
 * requests until phase 2 removes that path (releases spec, section 3).
 */
```

replace `workflowTemplate` (keep `LOCKFILES`, `DEFAULT_PNPM_VERSION`, `NODE_VERSION`, `COMMANDS`, `setupSteps` unchanged) with:

```ts
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
  group: vetra-\${{ github.event.pull_request.number || github.ref }}
  # A push may be cutting a release: let it finish.
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
    if: (${SAME_REPO}) && (github.event_name == 'pull_request' || github.ref == 'refs/heads/${productionBranch}')
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
```

- [ ] **Step 5: Update the setup PR**

In `subgraphs/vetra-apps/service.ts`, `openAppSetupPullRequest`, replace the object passed to `github.openPullRequestWithFile` with:

```ts
    {
      branch: "vetra/publish",
      path: ".github/workflows/vetra.yml",
      content: workflowTemplate(app.id, app.production_branch, repo),
      commitMessage: "ci: publish with Vetra",
      title: "Publish with Vetra",
      body: [
        "Adds (or replaces) `.github/workflows/vetra.yml`:",
        "",
        "- [powerhouse-inc/vetra-publish](https://github.com/powerhouse-inc/vetra-publish) publishes a build of every push and pull request, keeps a release PR open on each release branch, and publishes a release when you merge it,",
        `- [powerhouse-inc/vetra-deploy-action](https://github.com/powerhouse-inc/vetra-deploy-action) keeps deploying \`${app.production_branch}\` to the production environment and pull requests to previews, until releases replace it.`,
        "",
        `App: ${deps.cfg.vetraAppUrl}/user/apps/${app.id}`,
      ].join("\n"),
    },
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 7: Check the YAML parses as GitHub reads it**

Node 24 runs the `.ts` file directly (it has no imports); `js-yaml` parses like GitHub's loader for this subset:

```bash
T=$(mktemp -d)
for m in "'pnpm'" "'npm'" null; do
  node --input-type=module -e "const { workflowTemplate } = await import('./subgraphs/vetra-apps/workflow-template.ts'); process.stdout.write(workflowTemplate('app-1', 'release', { packageManager: $m }))" > "$T/w.yml"
  npx -y js-yaml@4.1.0 "$T/w.yml" | jq -c '[(.jobs|keys), .on.push.branches, (.jobs.deploy.if|.[-45:])]'
done
```

Expected: three lines, each `[["deploy","publish"],["**","!release-please--**"],"…== 'refs/heads/release')"]`.

- [ ] **Step 8: Commit**

```bash
git add subgraphs/vetra-apps/workflow-template.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__
git commit -m "feat(apps): generated vetra.yml publishes with vetra-publish

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Action repo scaffold and the ported modules

Needs: the user has created the public repo `powerhouse-inc/vetra-publish` with a `main` branch (README only).

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE` (MIT, as the old action), `.github/workflows/test.yml`
- Create (copied verbatim): `src/util.js`, `src/fetch-retry.js`, `src/oidc.js`, `src/exchange.js`, `src/token-source.js`, `src/rest.js`, `src/publish.js` and their tests `test/util.test.js`, `test/fetch-retry.test.js`, `test/oidc.test.js`, `test/exchange.test.js`, `test/token-source.test.js`, `test/rest.test.js`, `test/publish.test.js`

**Interfaces:**
- Produces (unchanged from vetra-deploy-action@87328cf): `execCmd(cmd, args, opts) → stdout`, `mask(v)`, `notice(m)`, `warning(m)`, `setFailed(m)`, `setOutput(name, value)`, `appendSummary(md)`; `withUnansweredRetry(fetch)`; `requestOidcToken(audience)`; `exchangeToken(renownUrl, subjectToken, audience)`; `createTokenSource(mint, {maxAgeMs})`; `appsAudience(vetraUrl)`, `appsCiBaseUrl(vetraUrl)`, `postJson(url, token, body, {fetchImpl, retries, sleep})` (throws `Error("<CODE>: <message>")` on an API error), `formatApiError`; `extractTarballName(packOutput, dir)`.

- [ ] **Step 1: Clone and branch**

```bash
cd /home/froid/projects && gh repo clone powerhouse-inc/vetra-publish && cd vetra-publish
git switch -c feat/v1
mkdir -p src test scripts .github/workflows
```

- [ ] **Step 2: Copy the modules and tests from vetra-deploy-action**

```bash
SHA=87328cfecaa759a8f6cff32aa50ca10479270df8
for f in src/util.js src/fetch-retry.js src/oidc.js src/exchange.js src/token-source.js src/rest.js src/publish.js \
         test/util.test.js test/fetch-retry.test.js test/oidc.test.js test/exchange.test.js test/token-source.test.js test/rest.test.js test/publish.test.js; do
  gh api "repos/powerhouse-inc/vetra-deploy-action/contents/$f?ref=$SHA" -q .content | base64 -d > "$f"
done
gh api "repos/powerhouse-inc/vetra-deploy-action/contents/LICENSE?ref=$SHA" -q .content | base64 -d > LICENSE
```

- [ ] **Step 3: Write `package.json`, `.gitignore` and CI**

`package.json`:

```json
{
  "name": "vetra-publish",
  "version": "1.0.0",
  "private": true,
  "description": "Composite GitHub Action that versions, builds, attests and reports builds and releases of a Vetra App.",
  "type": "module",
  "bin": { "vetra-publish": "dist/check/index.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test",
    "build": "node scripts/build.js"
  },
  "dependencies": {
    "release-please": "17.11.2"
  },
  "devDependencies": {
    "@vercel/ncc": "0.45.0"
  },
  "license": "MIT"
}
```

`.gitignore`:

```
node_modules/
```

`.github/workflows/test.yml`:

```yaml
name: Test
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm test
```

- [ ] **Step 4: Install and run the ported tests**

Run: `npm install --no-audit --no-fund -q && npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# pass <n>` and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold, with the token, REST and publish helpers of vetra-deploy-action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Version rules and build versions

**Files:**
- Create: `src/version.js`
- Test: `test/version.test.js`

**Interfaces:**
- Produces: `parseVersion(v) → {major, minor, patch, prerelease: (string|number)[]} | null`; `versionKind(v) → 'release' | 'build' | null`; `compareReleases(a, b) → number` (throws on builds); `branchIdent(branch) → string`; `buildVersion(proposed, {branch, pr, runNumber}) → string`; `nextAfter(latest: string|null, prereleaseId: string|null) → string`.

- [ ] **Step 1: Write the failing tests**

`test/version.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchIdent, buildVersion, compareReleases, nextAfter, versionKind } from '../src/version.js';

test('versionKind follows Vetra: alpha|beta|rc.N are releases, anything else a build', () => {
  assert.equal(versionKind('1.4.0'), 'release');
  assert.equal(versionKind('2.0.0-beta.1'), 'release');
  assert.equal(versionKind('2.0.0-rc.0'), 'release');
  assert.equal(versionKind('2.0.0-beta'), 'build');
  assert.equal(versionKind('1.4.0-main.37'), 'build');
  assert.equal(versionKind('2.0.0-beta.2-next.12'), 'build');
  assert.equal(versionKind('01.0.0'), null);
  assert.equal(versionKind('1.0.0+meta'), null);
});

test('compareReleases orders by semver, a prerelease before its release', () => {
  const sorted = ['2.0.0', '1.4.1', '2.0.0-beta.10', '2.0.0-beta.2', '2.0.0-rc.0'].sort(compareReleases);
  assert.deepEqual(sorted, ['1.4.1', '2.0.0-beta.2', '2.0.0-beta.10', '2.0.0-rc.0', '2.0.0']);
  assert.throws(() => compareReleases('1.0.0', '1.0.0-main.1'), /build/);
});

test('branchIdent makes a branch one prerelease identifier that is never a release marker', () => {
  assert.equal(branchIdent('main'), 'main');
  assert.equal(branchIdent('feat/login_page'), 'feat-login-page');
  assert.equal(branchIdent('1.x'), '1-x');
  assert.equal(branchIdent('2024'), 'b2024');
  assert.equal(branchIdent('beta'), 'branch-beta');
  assert.equal(branchIdent('///'), 'branch');
  assert.equal(branchIdent('x'.repeat(80)).length, 40);
});

test('buildVersion: <proposed>-<branch>.<run> and <proposed>-pr.<n>.<run>, always a build', () => {
  assert.equal(buildVersion('1.4.0', { branch: 'main', pr: null, runNumber: '37' }), '1.4.0-main.37');
  assert.equal(buildVersion('2.0.0-beta.2', { branch: 'next', pr: null, runNumber: 12 }), '2.0.0-beta.2-next.12');
  assert.equal(buildVersion('1.4.0', { branch: null, pr: 12, runNumber: '3' }), '1.4.0-pr.12.3');
  assert.equal(buildVersion('1.4.0', { branch: 'rc', pr: null, runNumber: '5' }), '1.4.0-branch-rc.5');
  assert.throws(() => buildVersion('1.4', { branch: 'main', pr: null, runNumber: '1' }), /not semver/);
  assert.throws(() => buildVersion('1.4.0', { branch: 'main', pr: null, runNumber: '0' }), /run number/);
});

test('nextAfter: one step after the latest release when release-please proposes nothing', () => {
  assert.equal(nextAfter(null, null), '0.1.0');
  assert.equal(nextAfter(null, 'beta'), '0.1.0-beta.0');
  assert.equal(nextAfter('1.4.0', null), '1.4.1');
  assert.equal(nextAfter('1.4.0', 'beta'), '1.4.1-beta.0');
  assert.equal(nextAfter('2.0.0-beta.3', 'beta'), '2.0.0-beta.4');
  assert.equal(nextAfter('2.0.0-beta.3', null), '2.0.0');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/version.test.js 2>&1 | tail -5`
Expected: FAIL, `Cannot find module '../src/version.js'`.

- [ ] **Step 3: Implement**

`src/version.js`:

```js
// Version rules of the releases spec (section 3), the same as Vetra's
// subgraphs/vetra-apps/releases/version.ts in vetra-cloud-package: keep the
// two in step. Every version is semver (no build metadata, no leading
// zeros); a release has no prerelease part or exactly alpha|beta|rc.<n>;
// anything else is a build.

const NUM = '(0|[1-9]\\d*)';
const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`);
const RELEASE_PRE = /^(alpha|beta|rc)\.\d+$/;
const MAX_IDENT = 40;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

export function versionKind(v) {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  return !m[4] || RELEASE_PRE.test(m[4]) ? 'release' : 'build';
}

function compareIdent(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order of two releases; throws when either is a build. */
export function compareReleases(a, b) {
  if (versionKind(a) !== 'release' || versionKind(b) !== 'release') {
    throw new Error(`compareReleases: ${a} or ${b} is a build, not a release`);
  }
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    const c = compareIdent(x.prerelease[i], y.prerelease[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * A branch name as one semver prerelease identifier: only [0-9A-Za-z-], at
 * most 40 characters, never purely numeric, never alpha/beta/rc (which would
 * turn `1.4.0-rc.5` into a release).
 */
export function branchIdent(branch) {
  let id = String(branch ?? '')
    .replace(/[^0-9A-Za-z-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_IDENT)
    .replace(/-$/, '');
  if (!id) id = 'branch';
  if (/^\d+$/.test(id)) id = `b${id}`;
  if (id === 'alpha' || id === 'beta' || id === 'rc') id = `branch-${id}`;
  return id.slice(0, MAX_IDENT);
}

/** The version of a build: `<proposed>-<branch>.<run>` (push) or `<proposed>-pr.<n>.<run>`. */
export function buildVersion(proposed, { branch, pr, runNumber }) {
  if (!parseVersion(proposed)) throw new Error(`proposed version ${proposed} is not semver`);
  const run = String(runNumber);
  if (!/^[1-9]\d*$/.test(run)) throw new Error(`run number ${run} is not a positive integer`);
  const middle = pr != null ? `pr.${pr}` : branchIdent(branch);
  const v = `${proposed}-${middle}.${run}`;
  if (versionKind(v) !== 'build') throw new Error(`${v} is not a build version`);
  return v;
}

/**
 * What a branch proposes when release-please has nothing to release: one
 * step after its latest release (the next prerelease number, or the next
 * patch), or 0.1.0 for a project without releases.
 */
export function nextAfter(latest, prereleaseId) {
  const p = latest ? parseVersion(latest) : null;
  if (!p) return prereleaseId ? `0.1.0-${prereleaseId}.0` : '0.1.0';
  const core = `${p.major}.${p.minor}.${p.patch}`;
  const [id, n] = p.prerelease;
  if (p.prerelease.length === 2 && RELEASE_PRE.test(`${id}.${n}`)) {
    return prereleaseId ? `${core}-${id}.${n + 1}` : core;
  }
  const patch = `${p.major}.${p.minor}.${p.patch + 1}`;
  return prereleaseId ? `${patch}-${prereleaseId}.0` : patch;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/version.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/version.js test/version.test.js
git commit -m "feat: version rules and build versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `vetra` section of `powerhouse.config.json`

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `parseVetraConfig(vetra) → { host: string, packageDirs: string[], prerelease: Record<string, 'alpha'|'beta'|'rc'>, requires: { powerhouse?: string, services?: string[], size?: string }, migrations: string[], migrates: boolean }` (throws one `Error` listing every problem); `readVetraConfig(dir)`; `hostDockerfile(dir, config) → 'hosts/<host>/Dockerfile'` (throws when missing, spec 14.11); `DEFAULT_MIGRATIONS`.

- [ ] **Step 1: Write the failing tests**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MIGRATIONS, hostDockerfile, parseVetraConfig, readVetraConfig } from '../src/config.js';

const defaults = { host: 'cli', packageDirs: ['.'], prerelease: {}, requires: {}, migrations: DEFAULT_MIGRATIONS, migrates: false };

test('no vetra section means the defaults; keys of ph vetra are ignored', () => {
  assert.deepEqual(parseVetraConfig(undefined), defaults);
  assert.deepEqual(parseVetraConfig({ connectPort: 2540, driveId: 'x' }), defaults);
});

test('reads every key the action owns', () => {
  const c = parseVetraConfig({
    host: 'cli',
    packageDirs: ['.', 'packages/sdk'],
    prerelease: { next: 'beta', canary: 'alpha' },
    requires: { powerhouse: '>=6.2.3', services: ['DOCLING'], size: 'M' },
    migrations: ['db/**'],
    migrates: true,
  });
  assert.deepEqual(c, {
    host: 'cli',
    packageDirs: ['.', 'packages/sdk'],
    prerelease: { next: 'beta', canary: 'alpha' },
    requires: { powerhouse: '>=6.2.3', services: ['DOCLING'], size: 'M' },
    migrations: ['db/**'],
    migrates: true,
  });
});

test('lists every problem at once', () => {
  assert.throws(
    () => parseVetraConfig({ host: 'CLI', prerelease: { next: 'gamma' }, requires: { size: 'huge', cpu: 2 }, migrates: 'yes' }),
    (err) => {
      for (const s of ['vetra.host', 'vetra.prerelease.next', 'vetra.requires.size', 'vetra.requires.cpu', 'vetra.migrates']) {
        assert.match(err.message, new RegExp(s.replace('.', '\\.')));
      }
      return true;
    },
  );
});

test('readVetraConfig: missing file is the defaults, bad JSON a clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-config-'));
  assert.deepEqual(readVetraConfig(dir), defaults);
  fs.writeFileSync(path.join(dir, 'powerhouse.config.json'), '{');
  assert.throws(() => readVetraConfig(dir), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'powerhouse.config.json'), JSON.stringify({ vetra: { host: 'desktop' } }));
  assert.equal(readVetraConfig(dir).host, 'desktop');
});

test('hostDockerfile requires hosts/<host>/Dockerfile (spec 14.11)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-host-'));
  assert.throws(() => hostDockerfile(dir, defaults), /hosts\/cli\/Dockerfile is missing.*ph generate hosts/s);
  fs.mkdirSync(path.join(dir, 'hosts/cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hosts/cli/Dockerfile'), 'FROM node:24\n');
  assert.equal(hostDockerfile(dir, defaults), 'hosts/cli/Dockerfile');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/config.test.js 2>&1 | tail -3`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/config.js`:

```js
// The `vetra` section of powerhouse.config.json, as far as this action reads
// it (releases spec, section 3). Other keys there (connectPort, driveId,
// driveUrl, previewDrive) belong to `ph vetra` and are ignored.

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'powerhouse.config.json';

/** Reactor and read-model migrations of a Powerhouse project. */
export const DEFAULT_MIGRATIONS = [
  'processors/*/migrations.ts',
  'processors/*/migrations/**',
  'document-models/*/upgrades/**',
];

const HOST = /^[a-z][a-z0-9-]{0,63}$/;
const PRERELEASE_IDS = ['alpha', 'beta', 'rc'];
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const REQUIRES_KEYS = ['powerhouse', 'services', 'size'];

const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isStringList = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim() !== '');

export function parseVetraConfig(vetra) {
  const out = {
    host: 'cli',
    packageDirs: ['.'],
    prerelease: {},
    requires: {},
    migrations: DEFAULT_MIGRATIONS,
    migrates: false,
  };
  if (vetra === undefined || vetra === null) return out;
  if (!isPlainObject(vetra)) throw new Error(`${CONFIG_FILE}: vetra must be an object`);
  const problems = [];
  const v = vetra;

  if (v.host !== undefined) {
    if (typeof v.host === 'string' && HOST.test(v.host)) out.host = v.host;
    else problems.push('vetra.host must be a lower-case host name such as "cli"');
  }
  if (v.packageDirs !== undefined) {
    if (isStringList(v.packageDirs)) out.packageDirs = v.packageDirs;
    else problems.push('vetra.packageDirs must be a list of directories ([] publishes no package)');
  }
  if (v.prerelease !== undefined) {
    if (!isPlainObject(v.prerelease)) {
      problems.push('vetra.prerelease must map branch names to alpha, beta or rc');
    } else {
      for (const [branch, id] of Object.entries(v.prerelease)) {
        if (PRERELEASE_IDS.includes(id)) out.prerelease[branch] = id;
        else problems.push(`vetra.prerelease.${branch} must be alpha, beta or rc (got ${JSON.stringify(id)})`);
      }
    }
  }
  if (v.requires !== undefined) {
    if (!isPlainObject(v.requires)) {
      problems.push('vetra.requires must be an object');
    } else {
      const r = v.requires;
      for (const k of Object.keys(r)) {
        if (!REQUIRES_KEYS.includes(k)) problems.push(`vetra.requires.${k} is not known (${REQUIRES_KEYS.join(', ')})`);
      }
      if (r.powerhouse !== undefined) {
        if (typeof r.powerhouse === 'string' && r.powerhouse.trim()) out.requires.powerhouse = r.powerhouse;
        else problems.push('vetra.requires.powerhouse must be a version range such as ">=6.2.3"');
      }
      if (r.services !== undefined) {
        if (isStringList(r.services)) out.requires.services = r.services;
        else problems.push('vetra.requires.services must be a list of service names');
      }
      if (r.size !== undefined) {
        if (SIZES.includes(r.size)) out.requires.size = r.size;
        else problems.push(`vetra.requires.size must be one of ${SIZES.join(', ')}`);
      }
    }
  }
  if (v.migrations !== undefined) {
    if (isStringList(v.migrations)) out.migrations = v.migrations;
    else problems.push('vetra.migrations must be a list of globs');
  }
  if (v.migrates !== undefined) {
    if (typeof v.migrates === 'boolean') out.migrates = v.migrates;
    else problems.push('vetra.migrates must be true or false');
  }
  if (problems.length) throw new Error(`${CONFIG_FILE}:\n- ${problems.join('\n- ')}`);
  return out;
}

export function readVetraConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(file)) return parseVetraConfig(undefined);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
  return parseVetraConfig(json?.vetra);
}

/** Publishing needs a host (spec 14.11): its Dockerfile, relative to `dir`. */
export function hostDockerfile(dir, config) {
  const rel = `hosts/${config.host}/Dockerfile`;
  if (!fs.existsSync(path.join(dir, rel))) {
    throw new Error(
      `Publishing needs a host: ${rel} is missing. Generate it with \`ph generate hosts\` ` +
        '(a Powerhouse version with uniform runners, FEATURE_UNIFORM_RUNNERS_ENABLED=1).',
    );
  }
  return rel;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/config.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: vetra section of powerhouse.config.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Run context, workload claim, inputs and Renown tokens

**Files:**
- Create: `src/run-context.js`, `src/claim.js`, `src/inputs.js`, `src/tokens.js`
- Test: `test/run-context.test.js`, `test/claim.test.js`, `test/inputs.test.js`, `test/tokens.test.js`

**Interfaces:**
- Produces: `runContext(env) → { event: 'push'|'pull_request', branch: string|null, pr: number|null, target: string, sha, repository, runNumber }`; `parseRemote(url) → 'owner/name' | null`; `workloadClaim(token) → { refClass: string|null, production: boolean, releaseBranch: boolean }`; `actionInputs(env) → { appId, vetraUrl, renownUrl, githubToken }`; `stepState(env) → { kind, version, notes, releaseBranch, production, imageRef, imageDigest, powerhouse, baseImage }`; `renownTokens(renownUrl, audience) → () => Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`test/run-context.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemote, runContext } from '../src/run-context.js';

const base = { GITHUB_SHA: 'c0ffee', GITHUB_REPOSITORY: 'acme/shop', GITHUB_RUN_NUMBER: '37' };

test('a push: its branch is the target', () => {
  assert.deepEqual(runContext({ ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feat/x' }), {
    event: 'push', branch: 'feat/x', pr: null, target: 'feat/x', sha: 'c0ffee', repository: 'acme/shop', runNumber: '37',
  });
});

test('a pull request: no branch, the base branch is the target, the merge commit is the commit', () => {
  const r = runContext({ ...base, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/12/merge', GITHUB_BASE_REF: 'next' });
  assert.deepEqual([r.branch, r.pr, r.target, r.sha], [null, 12, 'next', 'c0ffee']);
});

test('tags, dispatches and other events are refused with the reason', () => {
  assert.throws(() => runContext({ ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0' }), /tag/);
  assert.throws(() => runContext({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }), /push and pull_request/);
  assert.throws(() => runContext({ GITHUB_EVENT_NAME: 'push' }), /GitHub Actions/);
});

test('parseRemote reads https and ssh GitHub remotes', () => {
  assert.equal(parseRemote('https://github.com/acme/shop.git\n'), 'acme/shop');
  assert.equal(parseRemote('git@github.com:acme/shop.git'), 'acme/shop');
  assert.equal(parseRemote('https://gitlab.com/acme/shop.git'), null);
});
```

`test/claim.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workloadClaim } from '../src/claim.js';

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

test('reads refClass and releaseBranch from the vetra claim', () => {
  assert.deepEqual(workloadClaim(jwt({ vetra: { ref: 'refs/heads/next', refClass: 'BRANCH', releaseBranch: true } })), {
    refClass: 'BRANCH', production: false, releaseBranch: true,
  });
});

test('a Renown without the flag: only the production branch releases', () => {
  assert.equal(workloadClaim(jwt({ vetra: { refClass: 'PRODUCTION' } })).releaseBranch, true);
  assert.equal(workloadClaim(jwt({ vetra: { refClass: 'PREVIEW' } })).releaseBranch, false);
});

test('a token without a vetra claim is an error', () => {
  assert.throws(() => workloadClaim(jwt({ sub: 'x' })), /vetra claim/);
  assert.throws(() => workloadClaim('opaque'), /JWT/);
});
```

`test/inputs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionInputs, stepState } from '../src/inputs.js';

test('actionInputs: app-id required, URLs default', () => {
  assert.throws(() => actionInputs({}), /app-id/);
  assert.deepEqual(actionInputs({ INPUT_APP_ID: 'app-1', INPUT_GITHUB_TOKEN: 'ghs' }), {
    appId: 'app-1',
    vetraUrl: 'https://switchboard.vetra.io',
    renownUrl: 'https://switchboard.renown.vetra.io',
    githubToken: 'ghs',
  });
});

test('stepState reads what prepare handed over', () => {
  const env = {
    VETRA_KIND: 'release', VETRA_VERSION: '1.5.0', VETRA_NOTES: '## Features', VETRA_RELEASE_BRANCH: 'true',
    VETRA_PRODUCTION: 'false', VETRA_IMAGE_REF: 'cr.vetra.io/acme/shop:1.5.0', VETRA_IMAGE_DIGEST: 'sha256:aa',
    VETRA_POWERHOUSE: '6.2.3', VETRA_BASE_IMAGE: 'node:24@sha256:bb',
  };
  assert.deepEqual(stepState(env), {
    kind: 'release', version: '1.5.0', notes: '## Features', releaseBranch: true, production: false,
    imageRef: 'cr.vetra.io/acme/shop:1.5.0', imageDigest: 'sha256:aa', powerhouse: '6.2.3', baseImage: 'node:24@sha256:bb',
  });
  assert.equal(stepState({ ...env, VETRA_NOTES: '' }).notes, null);
  assert.throws(() => stepState({ ...env, VETRA_VERSION: '' }), /VETRA_VERSION/);
});
```

`test/tokens.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renownTokens } from '../src/tokens.js';

test('renownTokens: GitHub OIDC for renown.vetra.io, exchanged for the audience', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(String(url));
    if (String(url).startsWith('https://oidc')) return Response.json({ value: 'oidc-jwt' });
    assert.deepEqual(JSON.parse(init.body), { subject_token: 'oidc-jwt', audience: 'https://registry.vetra.io' });
    return Response.json({ access_token: 'renown-jwt' });
  });
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.example/token?x=1';
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'req';
  t.after(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  });
  const get = renownTokens('https://renown.example/', 'https://registry.vetra.io');
  assert.equal(await get(), 'renown-jwt');
  assert.equal(await get(), 'renown-jwt');
  assert.deepEqual(seen, [
    'https://oidc.example/token?x=1&audience=https%3A%2F%2Frenown.vetra.io',
    'https://renown.example/api/@powerhousedao/renown-package/workload/token',
  ]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/run-context.test.js test/claim.test.js test/inputs.test.js test/tokens.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 4` (modules missing).

- [ ] **Step 3: Implement**

`src/run-context.js`:

```js
// What this run is, from the GitHub Actions environment. Vetra accepts
// reports only from `push` (branch refs) and `pull_request` runs, and checks
// that commit, ref and event match the workload token.

export function runContext(env = process.env) {
  const sha = env.GITHUB_SHA;
  const repository = env.GITHUB_REPOSITORY;
  const runNumber = env.GITHUB_RUN_NUMBER;
  if (!sha || !repository || !runNumber) {
    throw new Error('not running in GitHub Actions (GITHUB_SHA, GITHUB_REPOSITORY or GITHUB_RUN_NUMBER missing)');
  }
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF ?? '';
  if (event === 'push') {
    const m = /^refs\/heads\/(.+)$/.exec(ref);
    if (!m) throw new Error(`vetra-publish runs on branch pushes, not on ${ref}: remove the tag trigger from vetra.yml`);
    return { event, branch: m[1], pr: null, target: m[1], sha, repository, runNumber };
  }
  if (event === 'pull_request') {
    const m = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
    if (!m || !env.GITHUB_BASE_REF) throw new Error(`unexpected pull request ref ${ref}`);
    return { event, branch: null, pr: Number(m[1]), target: env.GITHUB_BASE_REF, sha, repository, runNumber };
  }
  throw new Error(`vetra-publish runs on push and pull_request, not ${event}: Vetra records only those`);
}

/** `owner/name` of a GitHub remote URL, or null. */
export function parseRemote(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(String(url));
  return m ? `${m[1]}/${m[2]}` : null;
}
```

`src/claim.js`:

```js
// The `vetra` claim of a Renown workload token, read WITHOUT verification:
// only to decide what to try. Vetra verifies the token and re-checks every
// rule (releases/claim.ts).

export function workloadClaim(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Renown returned a token that is not a JWT');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Renown returned a token with an unreadable payload');
  }
  const v = payload?.vetra;
  if (!v || typeof v !== 'object') throw new Error('Renown returned a token without a vetra claim');
  const refClass = typeof v.refClass === 'string' ? v.refClass : null;
  return {
    refClass,
    production: refClass === 'PRODUCTION',
    // A Renown from before release branches sets no flag, but mints push
    // tokens only for the production branch (Vetra reads it the same way).
    releaseBranch: typeof v.releaseBranch === 'boolean' ? v.releaseBranch : refClass === 'PRODUCTION',
  };
}
```

`src/inputs.js`:

```js
// The action's inputs, and the state the prepare step hands to the finish
// step (action.yml passes prepare's outputs as VETRA_* variables).

export function actionInputs(env = process.env) {
  const appId = env.INPUT_APP_ID;
  if (!appId) throw new Error("input 'app-id' is required");
  return {
    appId,
    vetraUrl: env.INPUT_VETRA_URL || 'https://switchboard.vetra.io',
    renownUrl: env.INPUT_RENOWN_URL || 'https://switchboard.renown.vetra.io',
    githubToken: env.INPUT_GITHUB_TOKEN || '',
  };
}

export function stepState(env = process.env) {
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is missing: the prepare step did not finish`);
    return v;
  };
  return {
    kind: need('VETRA_KIND'),
    version: need('VETRA_VERSION'),
    notes: env.VETRA_NOTES ? env.VETRA_NOTES : null,
    releaseBranch: env.VETRA_RELEASE_BRANCH === 'true',
    production: env.VETRA_PRODUCTION === 'true',
    imageRef: need('VETRA_IMAGE_REF'),
    imageDigest: need('VETRA_IMAGE_DIGEST'),
    powerhouse: need('VETRA_POWERHOUSE'),
    baseImage: need('VETRA_BASE_IMAGE'),
  };
}
```

`src/tokens.js`:

```js
// Renown workload tokens per audience. They live 10 minutes and an image
// build can take longer: each source re-mints after 5 minutes.

import { exchangeToken } from './exchange.js';
import { requestOidcToken } from './oidc.js';
import { createTokenSource } from './token-source.js';
import { mask } from './util.js';

export const RENOWN_OIDC_AUDIENCE = 'https://renown.vetra.io';

export function renownTokens(renownUrl, audience) {
  return createTokenSource(async () => {
    const oidc = await requestOidcToken(RENOWN_OIDC_AUDIENCE);
    mask(oidc);
    const token = await exchangeToken(renownUrl, oidc, audience);
    mask(token);
    return token;
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/run-context.js src/claim.js src/inputs.js src/tokens.js test/run-context.test.js test/claim.test.js test/inputs.test.js test/tokens.test.js
git commit -m "feat: run context, workload claim, inputs and Renown tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: release-please

**Files:**
- Create: `src/release-please.js`
- Test: `test/release-please.test.js`

**Interfaces:**
- Consumes: `nextAfter` (Task 4).
- Produces: `ROOT = '.'`; `releaserConfig(prereleaseId: string|null) → ReleaserConfig`; `openGitHub({repository, token, branch}) → Promise<GitHub>`; `manifestFor(github, branch, prereleaseId) → Promise<Manifest>`; `proposedVersion(manifest, prereleaseId) → Promise<string>`; `cutRelease(manifest, sha, {warn}) → Promise<{version, notes} | null>`; `releaseAtCommit({repository, token, sha, fetchImpl}) → Promise<{version, notes} | null>`.

- [ ] **Step 1: Write the failing tests**

`test/release-please.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutRelease, proposedVersion, releaseAtCommit, releaserConfig } from '../src/release-please.js';

const v = (s) => ({ toString: () => s });

test('releaserConfig: node, plain v tags, prerelease versioning; <id>.0 on prerelease branches', () => {
  assert.deepEqual(releaserConfig(null), {
    releaseType: 'node',
    versioning: 'prerelease',
    includeComponentInTag: false,
    includeVInTag: true,
    changelogPath: 'CHANGELOG.md',
  });
  assert.deepEqual(releaserConfig('beta'), {
    ...releaserConfig(null),
    prerelease: true,
    prereleaseType: 'beta.0',
  });
});

test('proposedVersion: the release PR version, else one step after the latest release', async () => {
  assert.equal(await proposedVersion({ buildPullRequests: async () => [{ version: v('1.5.0') }], releasedVersions: {} }, null), '1.5.0');
  assert.equal(await proposedVersion({ buildPullRequests: async () => [], releasedVersions: { '.': v('2.0.0-beta.2') } }, 'beta'), '2.0.0-beta.3');
  assert.equal(await proposedVersion({ buildPullRequests: async () => [], releasedVersions: {} }, null), '0.1.0');
});

test('cutRelease returns the release tagged at this commit and warns about others', async () => {
  const warnings = [];
  const manifest = {
    createReleases: async () => [
      undefined,
      { sha: 'old', version: '1.4.1', notes: 'old', tagName: 'v1.4.1' },
      { sha: 'c0ffee', version: '1.5.0', notes: '## Features', tagName: 'v1.5.0' },
    ],
  };
  assert.deepEqual(await cutRelease(manifest, 'c0ffee', { warn: (m) => warnings.push(m) }), { version: '1.5.0', notes: '## Features' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /v1\.4\.1.*re-run/);
  assert.equal(await cutRelease({ createReleases: async () => [] }, 'c0ffee', { warn: () => {} }), null);
});

test('releaseAtCommit finds a published release whose tag points at this commit', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.authorization };
    return Response.json([
      { tag_name: 'v1.5.0', target_commitish: 'other', body: 'x', draft: false },
      { tag_name: 'v1.4.0', target_commitish: 'c0ffee', body: 'notes', draft: false },
    ]);
  };
  assert.deepEqual(await releaseAtCommit({ repository: 'acme/shop', token: 'ghs', sha: 'c0ffee', fetchImpl }), { version: '1.4.0', notes: 'notes' });
  assert.deepEqual(seen, { url: 'https://api.github.com/repos/acme/shop/releases?per_page=30', auth: 'Bearer ghs' });
  assert.equal(await releaseAtCommit({ repository: 'acme/shop', token: 'ghs', sha: 'none', fetchImpl }), null);
  await assert.rejects(
    releaseAtCommit({ repository: 'acme/shop', token: 'ghs', sha: 'c0ffee', fetchImpl: async () => new Response('', { status: 502 }) }),
    /502/,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/release-please.test.js 2>&1 | tail -3`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/release-please.js`:

```js
// release-please 17 as a library: one config per release branch, computed
// here, so app repos carry no release-please config. Tags are plain
// v<version>, so an existing v1.0.9 tag counts as the last release.
//
// versioning "prerelease" on every branch: with prerelease off it turns
// 2.0.0-beta.3 + any change into 2.0.0 (the default strategy would propose
// 2.1.0-beta.3); with prereleaseType "<id>.0" a prerelease branch proposes
// 2.0.0-beta.0, then beta.1… ("beta" alone would give 2.0.0-beta, a build).

import { GitHub, Manifest } from 'release-please';
import { nextAfter } from './version.js';

export const ROOT = '.';

export function releaserConfig(prereleaseId) {
  return {
    releaseType: 'node',
    versioning: 'prerelease',
    includeComponentInTag: false,
    includeVInTag: true,
    changelogPath: 'CHANGELOG.md',
    ...(prereleaseId ? { prerelease: true, prereleaseType: `${prereleaseId}.0` } : {}),
  };
}

export async function openGitHub({ repository, token, branch }) {
  const [owner, repo] = repository.split('/');
  return GitHub.create({ owner, repo, token, defaultBranch: branch });
}

export function manifestFor(github, branch, prereleaseId) {
  return Manifest.fromConfig(github, branch, releaserConfig(prereleaseId), {}, ROOT);
}

/** What the branch's release PR proposes (or would propose). */
export async function proposedVersion(manifest, prereleaseId) {
  const [pr] = await manifest.buildPullRequests();
  if (pr?.version) return pr.version.toString();
  return nextAfter(manifest.releasedVersions[ROOT]?.toString() ?? null, prereleaseId);
}

/**
 * Tags and releases every merged release PR of the branch (GitHub release
 * with its notes); returns the one at `sha`, i.e. this run's commit.
 */
export async function cutRelease(manifest, sha, { warn }) {
  const created = (await manifest.createReleases()).filter(Boolean);
  for (const r of created) {
    if (r.sha !== sha) {
      warn(`release ${r.tagName} was tagged at ${r.sha}, not at this run's commit ${sha}: re-run the workflow run of ${String(r.sha).slice(0, 7)} to publish it`);
    }
  }
  const mine = created.find((r) => r.sha === sha);
  return mine ? { version: mine.version, notes: mine.notes ?? '' } : null;
}

/** A re-run after the release was cut: the GitHub release whose tag points at `sha`. */
export async function releaseAtCommit({ repository, token, sha, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub releases of ${repository} answered HTTP ${res.status}`);
  const releases = await res.json();
  const hit = releases.find((r) => r.target_commitish === sha && /^v\d/.test(r.tag_name ?? '') && !r.draft);
  return hit ? { version: hit.tag_name.slice(1), notes: hit.body ?? '' } : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/release-please.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Check the two release-please behaviours the config relies on**

```bash
node --input-type=module -e "
import { PrereleaseVersioningStrategy } from 'release-please/build/src/versioning-strategies/prerelease.js';
import { Version } from 'release-please/build/src/version.js';
const feat = [{ type: 'feat', notes: [], breaking: false }];
const brk = [{ type: 'feat', notes: [], breaking: true }];
const beta = new PrereleaseVersioningStrategy({ prerelease: true, prereleaseType: 'beta.0' });
const main = new PrereleaseVersioningStrategy({ prerelease: false });
const b = async (s, v, c) => (await s.bump(Version.parse(v), c)).toString();
console.log(await b(beta, '1.4.0', brk), await b(beta, '2.0.0-beta.0', feat), await b(main, '2.0.0-beta.3', feat), await b(main, '1.4.0', feat));
"
```

Expected: `2.0.0-beta.0 2.0.0-beta.1 2.0.0 1.5.0` (checked while writing this plan with 17.11.2). If not, stop: the version rules of Task 4 no longer match release-please.

- [ ] **Step 6: Commit**

```bash
git add src/release-please.js test/release-please.test.js
git commit -m "feat: release-please per branch: proposals, releases, re-runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Release or build, and the version

**Files:**
- Create: `src/decide.js`, `src/vetra-api.js` (only `githubToken` and `registryToken` here; Task 12 adds `reportRelease`)
- Test: `test/decide.test.js`

**Interfaces:**
- Consumes: `runContext` shape (Task 6), `workloadClaim` shape (Task 6), `parseVetraConfig` shape (Task 5), Task 7's functions, `buildVersion`, `versionKind` (Task 4), `postJson`/`appsCiBaseUrl` (Task 3).
- Produces: `decideVersion({run, claim, config, appsToken, input}, deps?) → Promise<{ kind: 'release'|'build', version: string, notes: string|null }>`; `githubToken(vetraUrl, token, appId, opts?) → Promise<{token, expiresAt}>`; `registryToken(vetraUrl, token, appId, opts?) → Promise<{registry, username, password, repository, expiresAt}>`.

- [ ] **Step 1: Write the failing tests**

`test/decide.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVersion } from '../src/decide.js';

const v = (s) => ({ toString: () => s });
function fakeManifest({ created = [], proposal = null, latest = null } = {}) {
  const calls = [];
  return {
    calls,
    releasedVersions: latest ? { '.': v(latest) } : {},
    createReleases: async () => (calls.push('createReleases'), created),
    createPullRequests: async () => (calls.push('createPullRequests'), []),
    buildPullRequests: async () => (calls.push('buildPullRequests'), proposal ? [{ version: v(proposal) }] : []),
  };
}
function fakes(manifests, extra = {}) {
  const seen = { vetraTokens: 0, manifests: [] };
  const deps = {
    openGitHub: async ({ token, branch }) => ({ token, branch }),
    manifestFor: async (github, branch, prereleaseId) => {
      seen.manifests.push({ token: github.token, branch, prereleaseId });
      return manifests.shift();
    },
    githubToken: async () => ((seen.vetraTokens += 1), { token: 'ghs_release', expiresAt: 'x' }),
    releaseAtCommit: async () => null,
    warn: () => {},
    ...extra,
  };
  return { deps, seen };
}
const input = { appId: 'app-1', vetraUrl: 'https://v', githubToken: 'ghs_run' };
const config = { prerelease: { next: 'beta' } };
const appsToken = async () => 'renown';
const push = (branch) => ({ event: 'push', branch, pr: null, target: branch, sha: 'c0ffee', repository: 'acme/shop', runNumber: '37' });
const releaseBranch = { releaseBranch: true };

test('a merged release PR on a release branch is the release; the next release PR is opened', async () => {
  const cut = fakeManifest({ created: [{ sha: 'c0ffee', version: '1.5.0', notes: '## Features', tagName: 'v1.5.0' }] });
  const next = fakeManifest();
  const { deps, seen } = fakes([cut, next]);
  const r = await decideVersion({ run: push('main'), claim: releaseBranch, config, appsToken, input }, deps);
  assert.deepEqual(r, { kind: 'release', version: '1.5.0', notes: '## Features' });
  assert.deepEqual(cut.calls, ['createReleases']);
  assert.deepEqual(next.calls, ['createPullRequests']);
  assert.equal(seen.vetraTokens, 1);
  assert.deepEqual(seen.manifests[0], { token: 'ghs_release', branch: 'main', prereleaseId: null });
});

test('any other push to a release branch builds the proposed version and updates the release PR', async () => {
  const next = fakeManifest({ proposal: '1.5.0' });
  const { deps } = fakes([fakeManifest(), next]);
  const r = await decideVersion({ run: push('main'), claim: releaseBranch, config, appsToken, input }, deps);
  assert.deepEqual(r, { kind: 'build', version: '1.5.0-main.37', notes: null });
  assert.deepEqual(next.calls, ['createPullRequests', 'buildPullRequests']);
});

test('a prerelease branch proposes with its identifier', async () => {
  const { deps, seen } = fakes([fakeManifest(), fakeManifest({ proposal: '2.0.0-beta.2' })]);
  const r = await decideVersion({ run: push('next'), claim: releaseBranch, config, appsToken, input }, deps);
  assert.equal(r.version, '2.0.0-beta.2-next.37');
  assert.equal(seen.manifests[0].prereleaseId, 'beta');
});

test('a re-run after the release was cut reports the release again', async () => {
  const { deps } = fakes([fakeManifest(), fakeManifest()], {
    releaseAtCommit: async ({ sha, token }) => (sha === 'c0ffee' && token === 'ghs_release' ? { version: '1.5.0', notes: 'n' } : null),
  });
  const r = await decideVersion({ run: push('main'), claim: releaseBranch, config, appsToken, input }, deps);
  assert.deepEqual(r, { kind: 'release', version: '1.5.0', notes: 'n' });
});

test('a released version Vetra would read as a build is refused', async () => {
  const cut = fakeManifest({ created: [{ sha: 'c0ffee', version: '2.0.0-beta', notes: '', tagName: 'v2.0.0-beta' }] });
  const { deps } = fakes([cut, fakeManifest()]);
  await assert.rejects(
    decideVersion({ run: push('next'), claim: releaseBranch, config, appsToken, input }, deps),
    /alpha\.N, beta\.N or rc\.N/,
  );
});

test('pull requests build from the target branch with the run token; Vetra is not asked for a GitHub token', async () => {
  const { deps, seen } = fakes([fakeManifest({ proposal: '2.0.0-beta.2' })]);
  const run = { event: 'pull_request', branch: null, pr: 12, target: 'next', sha: 'm3rge', repository: 'acme/shop', runNumber: '3' };
  const r = await decideVersion({ run, claim: { releaseBranch: false }, config, appsToken, input }, deps);
  assert.deepEqual(r, { kind: 'build', version: '2.0.0-beta.2-pr.12.3', notes: null });
  assert.equal(seen.vetraTokens, 0);
  assert.deepEqual(seen.manifests, [{ token: 'ghs_run', branch: 'next', prereleaseId: 'beta' }]);
});

test('a push to another branch builds from its own history', async () => {
  const { deps, seen } = fakes([fakeManifest({ latest: '1.4.0' })]);
  const r = await decideVersion({ run: push('feat/login'), claim: { releaseBranch: false }, config, appsToken, input }, deps);
  assert.equal(r.version, '1.4.1-feat-login.37');
  assert.equal(seen.vetraTokens, 0);
});

test('a build without the run token is a clear error', async () => {
  const { deps } = fakes([]);
  await assert.rejects(
    decideVersion({ run: push('feat/x'), claim: { releaseBranch: false }, config, appsToken, input: { ...input, githubToken: '' } }, deps),
    /github-token/,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/decide.test.js 2>&1 | tail -3`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/vetra-api.js`:

```js
// The vetra-apps CI routes this action calls (vetra-cloud-package
// subgraphs/vetra-apps/ci.ts), each with a Renown token for the Vetra
// audience.

import { appsCiBaseUrl, postJson } from './rest.js';

/** POST ci/registry-token: push rights for the app's image repository (a 1-hour robot). */
export function registryToken(vetraUrl, token, appId, opts = {}) {
  return postJson(`${appsCiBaseUrl(vetraUrl)}/registry-token`, token, { appId }, opts);
}

/** POST ci/github-token: the Vetra GitHub App's token, for a push to a release branch only (spec 14.1). */
export function githubToken(vetraUrl, token, appId, opts = {}) {
  return postJson(`${appsCiBaseUrl(vetraUrl)}/github-token`, token, { appId }, opts);
}
```

`src/decide.js`:

```js
// Release or build, and the version (releases spec, section 3).
//
// A push to a release branch (Renown's releaseBranch on the workload token;
// Vetra checks it again) acts as the Vetra GitHub App: it tags and releases
// a merged release PR, then opens or updates the branch's next release PR.
// Every other run reads its target branch's proposal with the run's own
// token, and builds.

import {
  cutRelease,
  manifestFor as realManifestFor,
  openGitHub as realOpenGitHub,
  proposedVersion,
  releaseAtCommit as realReleaseAtCommit,
} from './release-please.js';
import { githubToken as realGithubToken } from './vetra-api.js';
import { mask, warning } from './util.js';
import { buildVersion, versionKind } from './version.js';

export async function decideVersion({ run, claim, config, appsToken, input }, deps = {}) {
  const {
    openGitHub = realOpenGitHub,
    manifestFor = realManifestFor,
    githubToken = realGithubToken,
    releaseAtCommit = realReleaseAtCommit,
    warn = warning,
  } = deps;
  const prereleaseId = config.prerelease[run.target] ?? null;

  if (run.event === 'push' && claim.releaseBranch) {
    const { token } = await githubToken(input.vetraUrl, await appsToken(), input.appId);
    mask(token);
    const github = await openGitHub({ repository: run.repository, token, branch: run.branch });
    const released =
      (await cutRelease(await manifestFor(github, run.branch, prereleaseId), run.sha, { warn })) ??
      (await releaseAtCommit({ repository: run.repository, token, sha: run.sha }));
    // After a release this starts the next release PR; otherwise it brings
    // the open one up to date with this push.
    const next = await manifestFor(github, run.branch, prereleaseId);
    await next.createPullRequests();
    if (released) {
      if (versionKind(released.version) !== 'release') {
        throw new Error(
          `release-please released ${released.version}, which Vetra reads as a build: a prerelease must be alpha.N, beta.N or rc.N (vetra.prerelease in powerhouse.config.json)`,
        );
      }
      return { kind: 'release', version: released.version, notes: released.notes };
    }
    return { kind: 'build', version: buildVersion(await proposedVersion(next, prereleaseId), run), notes: null };
  }

  if (!input.githubToken) {
    throw new Error("input 'github-token' is empty: it defaults to the run's own token, which reads the release history");
  }
  const github = await openGitHub({ repository: run.repository, token: input.githubToken, branch: run.target });
  const proposed = await proposedVersion(await manifestFor(github, run.target, prereleaseId), prereleaseId);
  return { kind: 'build', version: buildVersion(proposed, run), notes: null };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/decide.js src/vetra-api.js test/decide.test.js
git commit -m "feat: release or build, acting as the Vetra GitHub App on release branches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The host image

**Files:**
- Create: `src/dockerfile.js`, `src/image.js`
- Test: `test/dockerfile.test.js`, `test/image.test.js`

**Interfaces:**
- Consumes: `execCmd(cmd, args, opts)` (Task 3).
- Produces: `baseImageOf(dockerfileText, buildArgs) → string`; `dockerLogin({registry, username, password}, exec)`; `remoteDigest(ref, exec) → string|null`; `buildAndPush({ref, dockerfile, host, labels, context}, exec) → digest`; `publishImage({registry, repository, version, host, dockerfile, labels}, exec) → {name, ref, digest}`; `powerhouseVersion(ref, exec) → string`; `baseImageDigest(image, exec) → '<image>@sha256:…'`; `ociLabels({version, commit, repository, host}) → Record<string,string>`.

- [ ] **Step 1: Write the failing tests**

`test/dockerfile.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseImageOf } from '../src/dockerfile.js';

// Shape of a generated hosts/cli/Dockerfile (Sektar's, abridged).
const HOST = `# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24

FROM node:\${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION=12.10.1
RUN npm install -g pnpm@\${PNPM_VERSION} \\
 && npm cache clean --force

FROM base AS build
RUN echo build

FROM base AS runtime
COPY --from=build /app /app
`;

test('the final stage, through stage aliases, with global ARG defaults', () => {
  assert.equal(baseImageOf(HOST), 'node:24-bookworm-slim');
});

test('build args override ARG defaults; ${VAR:-x} and --platform are understood', () => {
  assert.equal(baseImageOf(HOST, { NODE_VERSION: '22' }), 'node:22-bookworm-slim');
  assert.equal(baseImageOf('ARG V\nFROM --platform=linux/amd64 alpine:${V:-3.20}\n'), 'alpine:3.20');
});

test('a Dockerfile without FROM is an error', () => {
  assert.throws(() => baseImageOf('# nothing\n'), /no FROM/);
});
```

`test/image.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseImageDigest, dockerLogin, ociLabels, powerhouseVersion, publishImage } from '../src/image.js';

const D = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
/** exec double: the first matching prefix answers (a function, a string, or an Error to throw). */
function fakeExec(answers) {
  const calls = [];
  const exec = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, opts });
    for (const [prefix, out] of answers) {
      if (!line.startsWith(prefix)) continue;
      const v = typeof out === 'function' ? out(line, opts) : out;
      if (v instanceof Error) throw v;
      return v;
    }
    return '';
  };
  return { exec, calls };
}
const target = {
  registry: 'cr.vetra.io',
  repository: 'acme/shop',
  version: '1.5.0',
  host: 'cli',
  dockerfile: 'hosts/cli/Dockerfile',
  labels: { 'org.opencontainers.image.version': '1.5.0' },
};

test('dockerLogin sends the password on stdin, never as an argument', () => {
  const { exec, calls } = fakeExec([]);
  dockerLogin({ registry: 'cr.vetra.io', username: 'robot$acme+ci', password: 's3cret' }, exec);
  assert.equal(calls[0].line, 'docker login cr.vetra.io -u robot$acme+ci --password-stdin');
  assert.equal(calls[0].opts.input, 's3cret');
});

test('a new tag is built from the host Dockerfile, pushed, and its digest read back', () => {
  const { exec, calls } = fakeExec([
    ['docker buildx imagetools inspect', new Error('not found')],
    ['docker inspect', `cr.vetra.io/acme/shop@${D}\n`],
  ]);
  assert.deepEqual(publishImage(target, exec), { name: 'cr.vetra.io/acme/shop', ref: 'cr.vetra.io/acme/shop:1.5.0', digest: D });
  const lines = calls.map((c) => c.line);
  assert.ok(lines.includes('docker build -f hosts/cli/Dockerfile --build-arg PH_HOST=cli --label org.opencontainers.image.version=1.5.0 -t cr.vetra.io/acme/shop:1.5.0 .'));
  assert.ok(lines.includes('docker push cr.vetra.io/acme/shop:1.5.0'));
});

test('an existing tag (a re-run) is reused: tags are never moved', () => {
  const { exec, calls } = fakeExec([
    ['docker buildx imagetools inspect', JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: D, size: 1 })],
  ]);
  assert.equal(publishImage(target, exec).digest, D);
  assert.ok(!calls.some((c) => c.line.startsWith('docker build') || c.line.startsWith('docker push')));
});

test('powerhouseVersion reads ph-cli from the image', () => {
  const { exec, calls } = fakeExec([['docker run', '6.2.3\n']]);
  assert.equal(powerhouseVersion('cr.vetra.io/acme/shop:1.5.0', exec), '6.2.3');
  assert.match(calls[0].line, /^docker run --rm --entrypoint node cr\.vetra\.io\/acme\/shop:1\.5\.0 -p /);
  assert.throws(() => powerhouseVersion('x', fakeExec([['docker run', 'Error: Cannot find module']]).exec), /ph-cli/);
});

test('baseImageDigest pins the base image, pulling it when the build did not', () => {
  let inspected = 0;
  const { exec, calls } = fakeExec([
    ['docker image inspect', () => (++inspected === 1 ? new Error('No such image') : `node@${B}\n`)],
  ]);
  assert.equal(baseImageDigest('node:24-bookworm-slim', exec), `node:24-bookworm-slim@${B}`);
  assert.ok(calls.some((c) => c.line === 'docker pull -q node:24-bookworm-slim'));
});

test('ociLabels', () => {
  assert.deepEqual(ociLabels({ version: '1.5.0', commit: 'c0ffee', repository: 'acme/shop', host: 'cli' }), {
    'org.opencontainers.image.version': '1.5.0',
    'org.opencontainers.image.revision': 'c0ffee',
    'org.opencontainers.image.source': 'https://github.com/acme/shop',
    'io.vetra.host': 'cli',
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/dockerfile.test.js test/image.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 2` (modules missing).

- [ ] **Step 3: Implement**

`src/dockerfile.js`:

```js
// The base image a host Dockerfile builds on (reported as built.baseImage):
// what the final stage starts FROM, through stage aliases, with global ARG
// defaults (or --build-arg values) substituted.

function logicalLines(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function substitute(value, vars) {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (_, braced, fallback, bare) => {
    const v = vars[braced ?? bare];
    return v !== undefined && v !== '' ? v : (fallback ?? '');
  });
}

export function baseImageOf(text, buildArgs = {}) {
  const globals = {};
  const stages = new Map();
  let last = null;
  for (const line of logicalLines(text)) {
    const [instruction, ...rest] = line.split(/\s+/);
    const op = instruction.toUpperCase();
    if (op === 'ARG' && last === null) {
      const [name, ...value] = rest.join(' ').split('=');
      const key = name.trim();
      globals[key] = buildArgs[key] ?? (value.length ? value.join('=').trim().replace(/^"(.*)"$/, '$1') : '');
    } else if (op === 'FROM') {
      const args = rest.filter((a) => !a.startsWith('--'));
      const image = substitute(args[0] ?? '', globals);
      if (!image) throw new Error(`Dockerfile: FROM without an image: ${line}`);
      last = stages.get(image.toLowerCase()) ?? image;
      if (args[1]?.toUpperCase() === 'AS' && args[2]) stages.set(args[2].toLowerCase(), last);
    }
  }
  if (last === null) throw new Error('Dockerfile has no FROM');
  return last;
}
```

`src/image.js`:

```js
// The app's host image: cr.vetra.io/<namespace>/<app>:<version>, built once
// from hosts/<host>/Dockerfile with the project root as context. Tags are
// written once: a re-run finds the tag and reuses its digest.

import { execCmd } from './util.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function dockerLogin({ registry, username, password }, exec = execCmd) {
  exec('docker', ['login', registry, '-u', username, '--password-stdin'], { input: password });
}

/** The digest of `ref` in the registry, or null when the tag does not exist. */
export function remoteDigest(ref, exec = execCmd) {
  try {
    const out = exec('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}']);
    const digest = JSON.parse(out).digest;
    return DIGEST.test(digest ?? '') ? digest : null;
  } catch {
    return null;
  }
}

export function buildAndPush({ ref, dockerfile, host, labels, context = '.' }, exec = execCmd) {
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  exec('docker', ['build', '-f', dockerfile, '--build-arg', `PH_HOST=${host}`, ...labelArgs, '-t', ref, context], { stdio: 'inherit' });
  exec('docker', ['push', ref], { stdio: 'inherit' });
  const repoDigest = exec('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', ref]).trim();
  const digest = repoDigest.split('@')[1];
  if (!DIGEST.test(digest ?? '')) throw new Error(`docker reported no digest for ${ref} (${repoDigest})`);
  return digest;
}

export function publishImage({ registry, repository, version, host, dockerfile, labels }, exec = execCmd) {
  const name = `${registry}/${repository}`;
  const ref = `${name}:${version}`;
  const existing = remoteDigest(ref, exec);
  if (existing) {
    console.log(`Vetra: ${ref} already exists (${existing}); reusing it.`);
    return { name, ref, digest: existing };
  }
  return { name, ref, digest: buildAndPush({ ref, dockerfile, host, labels }, exec) };
}

/** The Powerhouse version the image was built with: its @powerhousedao/ph-cli. */
export function powerhouseVersion(ref, exec = execCmd) {
  const out = exec('docker', [
    'run', '--rm', '--entrypoint', 'node', ref,
    '-p', "require('/app/node_modules/@powerhousedao/ph-cli/package.json').version",
  ]).trim();
  if (!/^\d+\.\d+\.\d+/.test(out)) {
    throw new Error(`could not read the Powerhouse version from ${ref} (got ${JSON.stringify(out.slice(0, 200))}): the host image must have @powerhousedao/ph-cli under /app`);
  }
  return out;
}

/** `<image>@sha256:…` of the base image (pulled when the build did not pull it). */
export function baseImageDigest(image, exec = execCmd) {
  const inspect = () => exec('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image]).trim();
  let out;
  try {
    out = inspect();
  } catch {
    exec('docker', ['pull', '-q', image]);
    out = inspect();
  }
  const digest = out.split('@')[1];
  if (!DIGEST.test(digest ?? '')) throw new Error(`no digest for base image ${image} (${out})`);
  return `${image}@${digest}`;
}

export function ociLabels({ version, commit, repository, host }) {
  return {
    'org.opencontainers.image.version': version,
    'org.opencontainers.image.revision': commit,
    'org.opencontainers.image.source': `https://github.com/${repository}`,
    'io.vetra.host': host,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Check the parser on Sektar's real Dockerfile**

Run: `node --input-type=module -e "import fs from 'node:fs'; import { baseImageOf } from './src/dockerfile.js'; console.log(baseImageOf(fs.readFileSync('/home/froid/projects/sektar/hosts/cli/Dockerfile','utf8')))"`
Expected: `node:24-bookworm-slim`.

- [ ] **Step 6: Commit**

```bash
git add src/dockerfile.js src/image.js test/dockerfile.test.js test/image.test.js
git commit -m "feat: build, push or reuse the host image; Powerhouse version and base image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: npm packages

**Files:**
- Create: `src/packages.js`
- Test: `test/packages.test.js`

**Interfaces:**
- Consumes: `extractTarballName` (Task 3 `src/publish.js`), `parseVersion` (Task 4), `execCmd`.
- Produces: `PRODUCTION_REGISTRY`, `DEV_REGISTRY`; `registryFor({releaseBranch, event}) → url`; `distTagFor({kind, version, branch, pr, production}) → string`; `publishableDirs(dirs, warn) → {dir, name}[]`; `publishPackages({dirs, version, registryUrl, distTag, token}, exec, log) → {name, version}[]`.

- [ ] **Step 1: Write the failing tests**

`test/packages.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEV_REGISTRY, PRODUCTION_REGISTRY, distTagFor, publishPackages, publishableDirs, registryFor } from '../src/packages.js';

test('registryFor: the production registry only for pushes to release branches', () => {
  assert.equal(registryFor({ releaseBranch: true, event: 'push' }), PRODUCTION_REGISTRY);
  assert.equal(registryFor({ releaseBranch: false, event: 'push' }), DEV_REGISTRY);
  assert.equal(registryFor({ releaseBranch: true, event: 'pull_request' }), DEV_REGISTRY);
});

test('distTagFor', () => {
  const t = (o) => distTagFor({ branch: null, pr: null, production: false, ...o });
  assert.equal(t({ kind: 'release', version: '1.5.0', branch: 'main', production: true }), 'latest');
  assert.equal(t({ kind: 'release', version: '1.4.2', branch: '1.x' }), 'latest-1');
  assert.equal(t({ kind: 'release', version: '2.0.0-beta.1', branch: 'next' }), 'next');
  assert.equal(t({ kind: 'build', version: '1.5.0-main.3', branch: 'main', production: true }), 'main');
  assert.equal(t({ kind: 'build', version: '1.5.0-feat-x.3', branch: 'feat/x' }), 'feat-x');
  assert.equal(t({ kind: 'build', version: '2.0.0-beta.1-next.3', branch: 'next' }), 'branch-next');
  assert.equal(t({ kind: 'build', version: '1.4.2-b1-x.3', branch: '1.x' }), 'branch-1-x');
  assert.equal(t({ kind: 'build', version: '1.5.0-pr.12.3', pr: 12 }), 'pr-12');
});

function project(pkgs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-pkg-'));
  for (const [dir, pkg] of Object.entries(pkgs)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    if (pkg) fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(pkg));
  }
  return root;
}

test('publishableDirs skips missing, private and unnamed packages', () => {
  const root = project({ a: { name: '@acme/a' }, b: { name: '@acme/b', private: true }, c: null, d: { version: '1.0.0' } });
  const warnings = [];
  const dirs = ['a', 'b', 'c', 'd'].map((d) => path.join(root, d));
  assert.deepEqual(publishableDirs(dirs, (m) => warnings.push(m)), [{ dir: dirs[0], name: '@acme/a' }]);
  assert.equal(warnings.length, 3);
});

test('publishPackages stamps the version, packs, publishes under the tag, and removes its .npmrc', () => {
  const root = project({ a: { name: '@acme/a', version: '0.0.0' } });
  const dir = path.join(root, 'a');
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    assert.equal(opts.cwd, dir);
    if (args[0] === 'view') return '';
    if (args[0] === 'pack') return 'acme-a-1.5.0.tgz\n';
    return '';
  };
  const out = publishPackages({ dirs: [{ dir, name: '@acme/a' }], version: '1.5.0', registryUrl: 'https://registry.vetra.io/', distTag: 'latest', token: 'tok' }, exec, () => {});
  assert.deepEqual(out, [{ name: '@acme/a', version: '1.5.0' }]);
  const npmrc = path.join(dir, '.npmrc.vetra-publish');
  assert.deepEqual(calls, [
    `npm view @acme/a@1.5.0 version --registry https://registry.vetra.io --userconfig ${npmrc}`,
    'npm version 1.5.0 --no-git-tag-version --allow-same-version',
    'pnpm pack',
    `npm publish ${path.join(dir, 'acme-a-1.5.0.tgz')} --registry https://registry.vetra.io --tag latest --userconfig ${npmrc}`,
  ]);
  assert.equal(fs.existsSync(npmrc), false);
});

test('a version already in the registry (a re-run) is not published again but still reported', () => {
  const root = project({ a: { name: '@acme/a' } });
  const dir = path.join(root, 'a');
  const calls = [];
  const exec = (cmd, args) => (calls.push(args[0]), args[0] === 'view' ? '1.5.0\n' : '');
  const out = publishPackages({ dirs: [{ dir, name: '@acme/a' }], version: '1.5.0', registryUrl: PRODUCTION_REGISTRY, distTag: 'latest', token: 't' }, exec, () => {});
  assert.deepEqual(out, [{ name: '@acme/a', version: '1.5.0' }]);
  assert.deepEqual(calls, ['view']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/packages.test.js 2>&1 | tail -3`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/packages.js`:

```js
// npm packages, published at the run's version (releases spec, section 3,
// step 4). package.json versions are stamped locally and never committed;
// pnpm pack resolves workspace:/catalog: ranges.

import fs from 'node:fs';
import path from 'node:path';
import { extractTarballName } from './publish.js';
import { execCmd } from './util.js';
import { parseVersion } from './version.js';

export const PRODUCTION_REGISTRY = 'https://registry.vetra.io';
export const DEV_REGISTRY = 'https://registry.dev.vetra.io';

/** Renown gives the production registry audience only to pushes on the production and release branches. */
export function registryFor({ releaseBranch, event }) {
  return event === 'push' && releaseBranch ? PRODUCTION_REGISTRY : DEV_REGISTRY;
}

const RESERVED_TAGS = /^(latest|next|latest-\d+)$/;

/**
 * Releases: latest (production branch), latest-<major> (other release
 * branches: a 1.x patch must not move latest back), next (prereleases).
 * Builds: the branch or pr-<n>; a branch that would clash with those tags or
 * parse as a version range (npm refuses `1.x`) gets `branch-` in front.
 */
export function distTagFor({ kind, version, branch, pr, production }) {
  if (kind === 'release') {
    const p = parseVersion(version);
    if (p.prerelease.length) return 'next';
    return production ? 'latest' : `latest-${p.major}`;
  }
  if (pr != null) return `pr-${pr}`;
  const tag = String(branch ?? '').replace(/[^0-9A-Za-z-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'branch';
  return RESERVED_TAGS.test(tag) || /^v?\d/.test(tag) ? `branch-${tag}` : tag;
}

export function publishableDirs(dirs, warn) {
  const out = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) {
      warn(`Vetra: no package.json in '${dir}': not publishing it.`);
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.private) {
      warn(`Vetra: '${dir}' (${pkg.name ?? 'unnamed'}) is private: not publishing it.`);
      continue;
    }
    if (!pkg.name) {
      warn(`Vetra: '${dir}' has no package name: not publishing it.`);
      continue;
    }
    out.push({ dir, name: pkg.name });
  }
  return out;
}

export function publishPackages({ dirs, version, registryUrl, distTag, token }, exec = execCmd, log = console.log) {
  const registry = registryUrl.replace(/\/+$/, '');
  const published = [];
  for (const { dir, name } of dirs) {
    const npmrc = path.join(dir, '.npmrc.vetra-publish');
    fs.writeFileSync(npmrc, `//${registry.replace(/^https?:\/\//, '')}/:_authToken=${token}\nregistry=${registry}/\n`, { mode: 0o600 });
    try {
      let already = '';
      try {
        already = exec('npm', ['view', `${name}@${version}`, 'version', '--registry', registry, '--userconfig', npmrc], { cwd: dir }).trim();
      } catch {
        already = ''; // E404: the package does not exist yet
      }
      if (already === version) {
        log(`Vetra: ${name}@${version} is already in ${registry}; not publishing it again.`);
      } else {
        exec('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: dir });
        const tarball = extractTarballName(exec('pnpm', ['pack'], { cwd: dir }), dir);
        exec('npm', ['publish', tarball, '--registry', registry, '--tag', distTag, '--userconfig', npmrc], { cwd: dir });
      }
      published.push({ name, version });
    } finally {
      fs.rmSync(npmrc, { force: true });
    }
  }
  return published;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/packages.js test/packages.test.js
git commit -m "feat: npm packages at the run's version, registry and dist-tag rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Does a release migrate

**Files:**
- Create: `src/migrates.js`
- Test: `test/migrates.test.js`

**Interfaces:**
- Consumes: `compareReleases`, `parseVersion`, `versionKind` (Task 4); config `migrations`, `migrates` (Task 5).
- Produces: `globToRegExp(glob) → RegExp`; `touchesMigrations(files, globs) → boolean`; `previousRelease(version, exec) → 'v<x>' | null`; `computeMigrates({version, config}, exec) → boolean`.

- [ ] **Step 1: Write the failing tests**

`test/migrates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIGRATIONS } from '../src/config.js';
import { computeMigrates, globToRegExp, previousRelease, touchesMigrations } from '../src/migrates.js';

test('globToRegExp: * within a segment, ** across segments', () => {
  assert.ok(globToRegExp('processors/*/migrations.ts').test('processors/email-index/migrations.ts'));
  assert.ok(!globToRegExp('processors/*/migrations.ts').test('processors/a/b/migrations.ts'));
  assert.ok(globToRegExp('document-models/*/upgrades/**').test('document-models/invoice/upgrades/v2/up.ts'));
  assert.ok(globToRegExp('**/schema.sql').test('db/x/schema.sql'));
  assert.ok(globToRegExp('**/schema.sql').test('schema.sql'));
  assert.ok(!globToRegExp('a.ts').test('aXts'));
});

test('touchesMigrations with the default folders', () => {
  assert.equal(touchesMigrations(['editors/x.tsx', 'processors/files-index/migrations.ts'], DEFAULT_MIGRATIONS), true);
  assert.equal(touchesMigrations(['editors/x.tsx', 'processors/files-index/processor.ts'], DEFAULT_MIGRATIONS), false);
});

const tags = (list) => (cmd, args) => {
  if (args[0] === 'tag') return list.join('\n');
  if (args[0] === 'diff') return `processors/a/migrations.ts\nREADME.md\n`;
  return '';
};

test('previousRelease: a full release migrates from the previous full release, a prerelease from any earlier release', () => {
  const exec = tags(['v1.3.0', 'v1.4.0', 'v2.0.0-beta.3', 'v1.5.0-main.2', 'vnext']);
  assert.equal(previousRelease('2.0.0', exec), 'v1.4.0');
  assert.equal(previousRelease('2.0.0-beta.4', exec), 'v2.0.0-beta.3');
  assert.equal(previousRelease('1.0.0', exec), null);
  assert.equal(previousRelease('1.0.0', () => { throw new Error('no HEAD^'); }), null);
});

test('computeMigrates: the config override, then the diff since the previous release', () => {
  const config = { migrations: DEFAULT_MIGRATIONS, migrates: false };
  assert.equal(computeMigrates({ version: '1.5.0', config }, tags(['v1.4.0'])), true);
  assert.equal(computeMigrates({ version: '1.5.0', config }, tags([])), false);
  assert.equal(computeMigrates({ version: '1.5.0', config: { ...config, migrates: true } }, tags([])), true);
  assert.equal(computeMigrates({ version: '1.5.0', config: { ...config, migrations: ['db/**'] } }, tags(['v1.4.0'])), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/migrates.test.js 2>&1 | tail -3`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/migrates.js`:

```js
// `migrates` of a release (releases spec, section 3): the commits since the
// previous release add or change files matching vetra.migrations, or the
// config says vetra.migrates: true. Needs the full history (fetch-depth: 0).

import { execCmd } from './util.js';
import { compareReleases, parseVersion, versionKind } from './version.js';

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function touchesMigrations(files, globs) {
  const res = globs.map(globToRegExp);
  return files.some((f) => res.some((r) => r.test(f)));
}

/**
 * The release `version` migrates from: the highest earlier release tag in
 * HEAD^'s history, counting only full releases for a full release (2.0.0
 * migrates from 1.4.0, not from 2.0.0-beta.3).
 */
export function previousRelease(version, exec = execCmd) {
  const full = parseVersion(version).prerelease.length === 0;
  let tags;
  try {
    tags = exec('git', ['tag', '--merged', 'HEAD^', '--list', 'v*']).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const earlier = tags
    .map((t) => t.slice(1))
    .filter((v) => versionKind(v) === 'release')
    .filter((v) => !full || parseVersion(v).prerelease.length === 0)
    .filter((v) => compareReleases(v, version) < 0)
    .sort(compareReleases);
  return earlier.length ? `v${earlier.at(-1)}` : null;
}

export function computeMigrates({ version, config }, exec = execCmd) {
  if (config.migrates) return true;
  const prev = previousRelease(version, exec);
  if (!prev) return false;
  const files = exec('git', ['diff', '--name-only', `${prev}..HEAD`]).split('\n').filter(Boolean);
  return touchesMigrations(files, config.migrations);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/migrates.js test/migrates.test.js
git commit -m "feat: migrates from the diff since the previous release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The report

**Files:**
- Create: `src/report.js`
- Modify: `src/vetra-api.js` (add `reportRelease`)
- Test: `test/report.test.js`, `test/vetra-api.test.js`

**Interfaces:**
- Consumes: `postJson`, `appsCiBaseUrl` (Task 3).
- Produces: `releaseBody({appId, version, kind, branch, pr, commit, notes, image: {ref, digest, host}, packages, requires, migrates, built: {powerhouse, baseImage}}) → body`; `summaryMarkdown(recorded) → string`; `reportRelease(vetraUrl, getToken, body, {fetchImpl, sleep, delays}) → Promise<ReleaseJson>`.

- [ ] **Step 1: Write the failing tests**

`test/report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseBody, summaryMarkdown } from '../src/report.js';

const D = `sha256:${'a'.repeat(64)}`;
const facts = {
  appId: 'app-1',
  version: '1.5.0',
  kind: 'release',
  branch: 'main',
  pr: null,
  commit: 'c0ffee',
  notes: '## Features',
  image: { ref: 'cr.vetra.io/acme/shop:1.5.0', digest: D, host: 'cli', extra: 'dropped' },
  packages: [{ name: '@acme/shop', version: '1.5.0', registryUrl: 'dropped' }],
  requires: { powerhouse: '>=6.2.3' },
  migrates: true,
  built: { powerhouse: '6.2.3', baseImage: `node:24@${D}` },
};

test('releaseBody is exactly what parseReleaseBody reads', () => {
  assert.deepEqual(releaseBody(facts), {
    appId: 'app-1',
    version: '1.5.0',
    kind: 'release',
    branch: 'main',
    pr: null,
    commit: 'c0ffee',
    notes: '## Features',
    image: { ref: 'cr.vetra.io/acme/shop:1.5.0', digest: D, host: 'cli' },
    packages: [{ name: '@acme/shop', version: '1.5.0' }],
    requires: { powerhouse: '>=6.2.3' },
    migrates: true,
    built: { powerhouse: '6.2.3', baseImage: `node:24@${D}` },
  });
});

test('a PR build: no branch, no notes, packages always an array', () => {
  const b = releaseBody({ ...facts, kind: 'build', version: '1.5.0-pr.12.3', branch: null, pr: 12, notes: 'x', packages: [] });
  assert.deepEqual([b.branch, b.pr, b.notes, b.packages], [null, 12, null, []]);
});

test('summaryMarkdown names the version, image and packages', () => {
  const md = summaryMarkdown({ kind: 'release', version: '1.5.0', commit: 'c0ffee', image: facts.image, packages: facts.packages, migrates: true });
  assert.match(md, /### Vetra release 1\.5\.0/);
  assert.match(md, new RegExp(`cr\\.vetra\\.io/acme/shop:1\\.5\\.0@${D}`));
  assert.match(md, /@acme\/shop@1\.5\.0/);
});
```

`test/vetra-api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubToken, registryToken, reportRelease } from '../src/vetra-api.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('registry-token and github-token post the app id to their routes', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push([url, init.body, init.headers.authorization]), json(200, { ok: true }));
  await registryToken('https://switchboard.vetra.io/', 'tok', 'app-1', { fetchImpl });
  await githubToken('https://switchboard.vetra.io', 'tok', 'app-1', { fetchImpl });
  const base = 'https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/ci';
  assert.deepEqual(seen, [
    [`${base}/registry-token`, '{"appId":"app-1"}', 'Bearer tok'],
    [`${base}/github-token`, '{"appId":"app-1"}', 'Bearer tok'],
  ]);
});

test('reportRelease retries SERVICE_UNAVAILABLE with a fresh token, then returns the record', async () => {
  let n = 0;
  const tokens = [];
  const fetchImpl = async (url, init) => {
    tokens.push(init.headers.authorization);
    return ++n === 1
      ? json(503, { error: 'SERVICE_UNAVAILABLE', message: 'Could not reach GitHub to verify the attestation; retry' })
      : json(200, { version: '1.5.0' });
  };
  let t = 0;
  const r = await reportRelease('https://v', async () => `t${++t}`, { version: '1.5.0' }, { fetchImpl, sleep: async () => {}, delays: [1] });
  assert.deepEqual(r, { version: '1.5.0' });
  assert.deepEqual(tokens, ['Bearer t1', 'Bearer t2']);
});

test('reportRelease explains VERSION_CONFLICT and does not retry verdicts', async () => {
  let n = 0;
  const conflict = async () => (n++, json(409, { error: 'VERSION_CONFLICT', message: '1.5.0 is already published with another image' }));
  await assert.rejects(reportRelease('https://v', async () => 't', { version: '1.5.0' }, { fetchImpl: conflict, sleep: async () => {} }), /tags are never moved/);
  assert.equal(n, 1);
  const forbidden = async () => json(403, { error: 'FORBIDDEN', message: 'nope' });
  await assert.rejects(reportRelease('https://v', async () => 't', {}, { fetchImpl: forbidden, sleep: async () => {} }), /FORBIDDEN: nope/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/report.test.js test/vetra-api.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: failures (module/export missing).

- [ ] **Step 3: Implement**

`src/report.js`:

```js
// POST ci/releases: the body exactly as vetra-cloud-package's
// parseReleaseBody (subgraphs/vetra-apps/ci.ts) reads it. Strict on the
// server: never send extra shapes or coerced types.

export function releaseBody(r) {
  const isPr = r.pr != null;
  return {
    appId: r.appId,
    version: r.version,
    kind: r.kind,
    branch: isPr ? null : r.branch,
    pr: isPr ? r.pr : null,
    commit: r.commit,
    notes: r.kind === 'release' ? (r.notes ?? '') : null,
    image: { ref: r.image.ref, digest: r.image.digest, host: r.image.host },
    packages: r.packages.map(({ name, version }) => ({ name, version })),
    requires: r.requires,
    migrates: r.migrates,
    built: { powerhouse: r.built.powerhouse, baseImage: r.built.baseImage },
  };
}

/** Job summary of what Vetra recorded. */
export function summaryMarkdown(r) {
  const packages = r.packages.map((p) => `\`${p.name}@${p.version}\``).join(', ') || 'none';
  return [
    `### Vetra ${r.kind} ${r.version}`,
    '',
    '| | |',
    '|---|---|',
    `| Image | \`${r.image.ref}@${r.image.digest}\` |`,
    `| Commit | \`${r.commit}\` |`,
    `| Packages | ${packages} |`,
    `| Migrates | ${r.migrates ? 'yes' : 'no'} |`,
    '',
  ].join('\n');
}
```

Append to `src/vetra-api.js`:

```js
const REPORT_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * POST ci/releases. Vetra answers SERVICE_UNAVAILABLE when Renown, Harbor or
 * GitHub did not answer: retried with a fresh token (a report is idempotent,
 * 200 for a version it already has with the same digest). Verdicts are not
 * retried.
 */
export async function reportRelease(vetraUrl, getToken, body, opts = {}) {
  const delays = opts.delays ?? REPORT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJson(`${appsCiBaseUrl(vetraUrl)}/releases`, await getToken(), body, { fetchImpl: opts.fetchImpl });
    } catch (err) {
      const message = String(err?.message ?? err);
      if (message.startsWith('VERSION_CONFLICT:')) {
        throw new Error(
          `${message}. Vetra already has ${body.version} with another image digest, and tags are never moved: publish a new version instead.`,
        );
      }
      if (!message.startsWith('SERVICE_UNAVAILABLE:') || attempt >= delays.length) throw err;
      console.log(`Vetra: ${message}; retrying in ${delays[attempt] / 1000}s.`);
      await sleep(delays[attempt]);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/report.js src/vetra-api.js test/report.test.js test/vetra-api.test.js
git commit -m "feat: the ci/releases report and job summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Entry points, `action.yml`, bundle

**Files:**
- Create: `src/prepare.js`, `src/finish.js`, `action.yml`, `scripts/build.js`, `dist/` (generated, committed)
- Modify: `.github/workflows/test.yml` (dist check)

**Interfaces:**
- Consumes: everything above.
- Produces: the action's inputs `app-id` (required), `vetra-url`, `renown-url`, `install-command` (default `pnpm install --frozen-lockfile`), `build-command` (default `pnpm build`), `github-token` (default `${{ github.token }}`); outputs `kind`, `version`, `image` (`<ref>@<digest>`). prepare's step outputs: `kind`, `version`, `notes`, `release-branch`, `production`, `image-name`, `image-ref`, `image-digest`, `powerhouse`, `base-image`, `publish`.

- [ ] **Step 1: Write `src/prepare.js`**

```js
// Step 1 of vetra-publish: what this run publishes (release or build, the
// version), the release PR on release branches, then the host image. The
// composite attests the image next, then runs finish.js.

import fs from 'node:fs';
import { workloadClaim } from './claim.js';
import { hostDockerfile, readVetraConfig } from './config.js';
import { decideVersion } from './decide.js';
import { baseImageOf } from './dockerfile.js';
import { withUnansweredRetry } from './fetch-retry.js';
import { baseImageDigest, dockerLogin, ociLabels, powerhouseVersion, publishImage } from './image.js';
import { actionInputs } from './inputs.js';
import { publishableDirs } from './packages.js';
import { appsAudience } from './rest.js';
import { runContext } from './run-context.js';
import { renownTokens } from './tokens.js';
import { mask, notice, setFailed, setOutput, warning } from './util.js';
import { registryToken } from './vetra-api.js';

async function main() {
  // A request after a long build can hit a dead keep-alive socket.
  globalThis.fetch = withUnansweredRetry(globalThis.fetch);
  const input = actionInputs();
  const run = runContext();
  const dir = process.cwd();
  const config = readVetraConfig(dir);
  const dockerfile = hostDockerfile(dir, config);

  const appsToken = renownTokens(input.renownUrl, appsAudience(input.vetraUrl));
  const claim = workloadClaim(await appsToken());
  const releaseBranch = run.event === 'push' && claim.releaseBranch;
  const { kind, version, notes } = await decideVersion({ run, claim, config, appsToken, input });
  notice(`Vetra: ${kind} ${version}`);

  const reg = await registryToken(input.vetraUrl, await appsToken(), input.appId);
  mask(reg.password);
  dockerLogin(reg);
  const image = publishImage({
    registry: reg.registry,
    repository: reg.repository,
    version,
    host: config.host,
    dockerfile,
    labels: ociLabels({ version, commit: run.sha, repository: run.repository, host: config.host }),
  });
  const powerhouse = powerhouseVersion(image.ref);
  const baseImage = baseImageDigest(baseImageOf(fs.readFileSync(dockerfile, 'utf8'), { PH_HOST: config.host }));
  const publish = publishableDirs(config.packageDirs, warning).length > 0;

  const outputs = {
    kind,
    version,
    notes: notes ?? '',
    'release-branch': String(releaseBranch),
    production: String(claim.production),
    'image-name': image.name,
    'image-ref': image.ref,
    'image-digest': image.digest,
    powerhouse,
    'base-image': baseImage,
    publish: String(publish),
  };
  for (const [k, v] of Object.entries(outputs)) setOutput(k, v);
}

main().catch((err) => setFailed(err?.stack || String(err?.message || err)));
```

- [ ] **Step 2: Write `src/finish.js`**

```js
// Step 2 of vetra-publish, after the attestation: npm packages at the run's
// version, then POST ci/releases. Deploys nothing.

import { readVetraConfig } from './config.js';
import { withUnansweredRetry } from './fetch-retry.js';
import { actionInputs, stepState } from './inputs.js';
import { computeMigrates } from './migrates.js';
import { distTagFor, publishPackages, publishableDirs, registryFor } from './packages.js';
import { releaseBody, summaryMarkdown } from './report.js';
import { appsAudience } from './rest.js';
import { runContext } from './run-context.js';
import { renownTokens } from './tokens.js';
import { appendSummary, setFailed, setOutput, warning } from './util.js';
import { reportRelease } from './vetra-api.js';

async function main() {
  globalThis.fetch = withUnansweredRetry(globalThis.fetch);
  const input = actionInputs();
  const run = runContext();
  const config = readVetraConfig(process.cwd());
  const s = stepState();

  let packages = [];
  const dirs = publishableDirs(config.packageDirs, warning);
  if (dirs.length) {
    const registryUrl = registryFor({ releaseBranch: s.releaseBranch, event: run.event });
    const token = await renownTokens(input.renownUrl, registryUrl)();
    const distTag = distTagFor({ kind: s.kind, version: s.version, branch: run.branch, pr: run.pr, production: s.production });
    packages = publishPackages({ dirs, version: s.version, registryUrl, distTag, token });
  }

  const body = releaseBody({
    appId: input.appId,
    version: s.version,
    kind: s.kind,
    branch: run.branch,
    pr: run.pr,
    commit: run.sha,
    notes: s.notes,
    image: { ref: s.imageRef, digest: s.imageDigest, host: config.host },
    packages,
    requires: config.requires,
    migrates: s.kind === 'release' ? computeMigrates({ version: s.version, config }) : false,
    built: { powerhouse: s.powerhouse, baseImage: s.baseImage },
  });
  const recorded = await reportRelease(input.vetraUrl, renownTokens(input.renownUrl, appsAudience(input.vetraUrl)), body);
  appendSummary(summaryMarkdown(recorded));
  setOutput('kind', s.kind);
  setOutput('version', s.version);
  setOutput('image', `${s.imageRef}@${s.imageDigest}`);
}

main().catch((err) => setFailed(err?.stack || String(err?.message || err)));
```

- [ ] **Step 3: Write `action.yml`**

```yaml
name: 'Vetra Publish'
description: 'Versions, builds, attests and reports each build and release of a Vetra App. Deploys nothing.'
author: 'Powerhouse'
branding:
  icon: 'package'
  color: 'purple'

inputs:
  app-id:
    description: 'The Vetra App id, from the app page on vetra.io.'
    required: true
  vetra-url:
    description: 'Vetra switchboard URL (CI API at <vetra-url>/api/@powerhousedao/vetra-cloud-package/apps/ci).'
    required: false
    default: 'https://switchboard.vetra.io'
  renown-url:
    description: 'Renown switchboard URL, for the OIDC-to-bearer token exchange.'
    required: false
    default: 'https://switchboard.renown.vetra.io'
  install-command:
    description: 'Installs dependencies before packages are built. Runs only when there is a package to publish; empty skips it.'
    required: false
    default: 'pnpm install --frozen-lockfile'
  build-command:
    description: 'Builds the packages before they are published. Runs only when there is a package to publish; empty skips it.'
    required: false
    default: 'pnpm build'
  github-token:
    description: "Reads the release history for builds. Release PRs, tags and GitHub releases use the Vetra GitHub App's token, never this one."
    required: false
    default: ${{ github.token }}

outputs:
  kind:
    description: 'release or build'
    value: ${{ steps.finish.outputs.kind }}
  version:
    description: 'The version this run published'
    value: ${{ steps.finish.outputs.version }}
  image:
    description: 'The host image, <ref>@<digest>'
    value: ${{ steps.finish.outputs.image }}

runs:
  using: 'composite'
  steps:
    - name: Version and host image
      id: prepare
      shell: bash
      run: node "${{ github.action_path }}/dist/prepare/index.js"
      env:
        INPUT_APP_ID: ${{ inputs.app-id }}
        INPUT_VETRA_URL: ${{ inputs.vetra-url }}
        INPUT_RENOWN_URL: ${{ inputs.renown-url }}
        INPUT_GITHUB_TOKEN: ${{ inputs.github-token }}

    # Signed with this run's identity: the caller's .github/workflows/vetra.yml.
    - name: Attest the host image
      uses: actions/attest-build-provenance@v2
      with:
        subject-name: ${{ steps.prepare.outputs.image-name }}
        subject-digest: ${{ steps.prepare.outputs.image-digest }}

    - name: Install dependencies
      if: steps.prepare.outputs.publish == 'true' && inputs.install-command != ''
      shell: bash
      run: ${{ inputs.install-command }}

    - name: Build packages
      if: steps.prepare.outputs.publish == 'true' && inputs.build-command != ''
      shell: bash
      run: ${{ inputs.build-command }}

    - name: Packages and report
      id: finish
      shell: bash
      run: node "${{ github.action_path }}/dist/finish/index.js"
      env:
        INPUT_APP_ID: ${{ inputs.app-id }}
        INPUT_VETRA_URL: ${{ inputs.vetra-url }}
        INPUT_RENOWN_URL: ${{ inputs.renown-url }}
        VETRA_KIND: ${{ steps.prepare.outputs.kind }}
        VETRA_VERSION: ${{ steps.prepare.outputs.version }}
        VETRA_NOTES: ${{ steps.prepare.outputs.notes }}
        VETRA_RELEASE_BRANCH: ${{ steps.prepare.outputs.release-branch }}
        VETRA_PRODUCTION: ${{ steps.prepare.outputs.production }}
        VETRA_IMAGE_REF: ${{ steps.prepare.outputs.image-ref }}
        VETRA_IMAGE_DIGEST: ${{ steps.prepare.outputs.image-digest }}
        VETRA_POWERHOUSE: ${{ steps.prepare.outputs.powerhouse }}
        VETRA_BASE_IMAGE: ${{ steps.prepare.outputs.base-image }}

    - name: Log out of cr.vetra.io
      if: always()
      shell: bash
      run: docker logout cr.vetra.io >/dev/null 2>&1 || true
```

- [ ] **Step 4: Write `scripts/build.js` and bundle**

`scripts/build.js` (it bundles `src/check.js` too, which Task 14 adds; until then build only prepare and finish by running Step 5's command with the list below, then Task 14 re-runs the full build):

```js
// Bundles each entry point with ncc into dist/<entry>/index.js (ESM, with
// release-please's template files next to it). dist/ is committed: the
// action runs it without an install. The check CLI keeps a shebang.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const entries = (process.argv[2] ?? 'prepare,finish,check').split(',');
for (const entry of entries) {
  fs.rmSync(`dist/${entry}`, { recursive: true, force: true });
  execFileSync('npx', ['ncc', 'build', `src/${entry}.js`, '-o', `dist/${entry}`, '--quiet', '--license', 'licenses.txt'], { stdio: 'inherit' });
}
const cli = 'dist/check/index.js';
if (fs.existsSync(cli)) {
  const text = fs.readFileSync(cli, 'utf8');
  if (!text.startsWith('#!')) fs.writeFileSync(cli, `#!/usr/bin/env node\n${text}`);
  fs.chmodSync(cli, 0o755);
}
```

- [ ] **Step 5: Build and smoke-run the bundles**

```bash
node scripts/build.js prepare,finish
ls dist/prepare | grep -c '\.hbs$'
env -i PATH="$PATH" node dist/prepare/index.js; echo "exit $?"
```

Expected: a non-zero count of `.hbs` files; the run prints `::error::Error: input 'app-id' is required` and `exit 1` (the bundle loads, fails on the first input).

- [ ] **Step 6: Add the dist check to CI**

Append to the `test` job's steps in `.github/workflows/test.yml`:

```yaml
      - run: npm run build
      - name: dist matches the source
        run: git diff --exit-code -- dist
```

- [ ] **Step 7: Run all tests**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/prepare.js src/finish.js action.yml scripts/build.js dist .github/workflows/test.yml
git commit -m "feat: composite action: prepare, attest, packages, report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `vetra-publish check` (spec 14.10) and the README

**Files:**
- Create: `src/check.js`, `README.md` (replace the repo's initial one)
- Modify: `dist/` (rebuilt with `check`)

**Interfaces:**
- Consumes: `readVetraConfig`, `hostDockerfile` (Task 5), `parseRemote` (Task 6), `openGitHub`, `manifestFor`, `proposedVersion` (Task 7), `execCmd`.
- Produces: `npx -y github:powerhouse-inc/vetra-publish#v1 check [--branch <name>]`, exit 0 when the project can publish, 1 with the problems listed otherwise.

- [ ] **Step 1: Write `src/check.js`**

```js
// `vetra-publish check` (releases spec 14.10): validates powerhouse.config.json's
// vetra section and the host, and prints the version the next release from a
// branch would get (from the branch as pushed to GitHub). Run in a project:
//   npx -y github:powerhouse-inc/vetra-publish#v1 check [--branch <name>]
// GITHUB_TOKEN, GH_TOKEN or a logged-in `gh` reads the release history.

import { hostDockerfile, readVetraConfig } from './config.js';
import { manifestFor, openGitHub, proposedVersion } from './release-please.js';
import { parseRemote } from './run-context.js';
import { execCmd } from './util.js';

const tryExec = (cmd, args) => {
  try {
    return execCmd(cmd, args).trim();
  } catch {
    return '';
  }
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    console.error('usage: vetra-publish check [--branch <name>]');
    process.exitCode = 2;
    return;
  }
  const dir = process.cwd();
  const config = readVetraConfig(dir);
  const dockerfile = hostDockerfile(dir, config);
  console.log(`ok   powerhouse.config.json: host ${config.host} (${dockerfile}), packages ${config.packageDirs.join(', ') || 'none'}`);

  const i = rest.indexOf('--branch');
  const branch = i >= 0 ? rest[i + 1] : tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repository = parseRemote(tryExec('git', ['remote', 'get-url', 'origin']));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || tryExec('gh', ['auth', 'token']);
  if (!branch || !repository || !token) {
    console.log('--   next release: unknown (needs a GitHub origin, a branch, and GITHUB_TOKEN, GH_TOKEN or `gh auth login`)');
    return;
  }
  const prereleaseId = config.prerelease[branch] ?? null;
  const github = await openGitHub({ repository, token, branch });
  const version = await proposedVersion(await manifestFor(github, branch, prereleaseId), prereleaseId);
  console.log(`ok   next release from ${branch}: ${version} (published only if ${branch} is the production branch or a release branch of the app in Vetra)`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`fail ${err?.message ?? err}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Build and run it against Sektar**

```bash
node scripts/build.js
(cd /home/froid/projects/sektar && node /home/froid/projects/vetra-publish/dist/check/index.js check --branch main)
```

Expected: `ok   powerhouse.config.json: host cli (hosts/cli/Dockerfile), packages .` and `ok   next release from main: 1.0.10` or `1.1.0` (whatever Sektar's commits since `v1.0.9` propose; any version after 1.0.9 is right). And in an empty directory: `(cd "$(mktemp -d)" && node /home/froid/projects/vetra-publish/dist/check/index.js check)` prints `fail Publishing needs a host: hosts/cli/Dockerfile is missing…` with exit code 1.

- [ ] **Step 3: Write `README.md`**

~~~~markdown
# vetra-publish

Publishes every build and release of a [Vetra](https://vetra.io) App from GitHub Actions:

1. **Version.** A push to a release branch (your App's production branch, or one listed in its
   release branches in Vetra) keeps a release PR open with the next version and changelog
   (release-please, from conventional commits). Merging it tags `v<version>`, creates the GitHub
   release, and this run publishes that release. Every other push and same-repo PR publishes a
   build: `<proposed>-<branch>.<run>` or `<proposed>-pr.<n>.<run>`.
2. **Host image.** Builds `hosts/<host>/Dockerfile` (default `cli`) once and pushes
   `cr.vetra.io/<namespace>/<app>:<version>`. Tags are never moved.
3. **Attestation.** `actions/attest-build-provenance` signs the image with this run's identity.
4. **Packages.** Publishes each package in `vetra.packageDirs` at the same version: builds to
   `registry.dev.vetra.io` (or `registry.vetra.io` on release branches) under the branch or
   `pr-<n>` dist-tag, releases to `registry.vetra.io` under `latest` (`latest-<major>` from a
   maintenance branch) or `next` (prereleases).
5. **Report.** Records the build or release in Vetra (`POST ci/releases`). It deploys nothing.

No secrets: every credential is minted per run from the run's GitHub OIDC token, through Renown.
Release PRs and tags are made as the Vetra GitHub App, so they start workflows.

## Workflow

Vetra generates `.github/workflows/vetra.yml` for you (the setup pull request). The file must be
named `vetra.yml`: Vetra accepts only images attested by it.

```yaml
name: Vetra
on:
  push:
    branches: ['**', '!release-please--**']
  pull_request:
    types: [opened, synchronize, reopened]
permissions: {}
concurrency:
  group: vetra-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  publish:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
      attestations: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - uses: powerhouse-inc/vetra-publish@v1
        with:
          app-id: <APP_ID>
```

## Inputs

| Input | Default | |
|---|---|---|
| `app-id` | required | The Vetra App id. |
| `vetra-url` | `https://switchboard.vetra.io` | |
| `renown-url` | `https://switchboard.renown.vetra.io` | |
| `install-command` | `pnpm install --frozen-lockfile` | Runs only when there is a package to publish. |
| `build-command` | `pnpm build` | Runs only when there is a package to publish. |
| `github-token` | `${{ github.token }}` | Reads release history for builds. |

Outputs: `kind` (`release` or `build`), `version`, `image` (`<ref>@<digest>`).

## `powerhouse.config.json`

All optional, in the `vetra` section next to `ph vetra`'s own keys:

```json
{
  "vetra": {
    "host": "cli",
    "packageDirs": ["."],
    "prerelease": { "next": "beta" },
    "requires": { "powerhouse": ">=6.2.3", "services": ["DOCLING"], "size": "M" },
    "migrations": ["processors/*/migrations.ts", "processors/*/migrations/**", "document-models/*/upgrades/**"],
    "migrates": false
  }
}
```

- `prerelease`: release branches that publish prereleases, and their identifier (`alpha`, `beta`,
  `rc`): `next` proposes `2.0.0-beta.0`, `beta.1`…
- `migrations`: a release whose commits since the previous release touch these files is marked
  as migrating (rollouts then back up and rehearse). `migrates: true` forces it for the next release.

Check it before pushing: `npx -y github:powerhouse-inc/vetra-publish#v1 check`.

## Releases

- PR titles must be conventional commits (`feat: …`, `fix: …`, `feat!: …`): squash merges make
  them the commit release-please reads.
- Finishing a prerelease line: bring `next` into `main` with a conventional commit such as
  `feat!: 2.0`, or a commit with the footer `Release-As: 2.0.0`.
- Changing a branch's prerelease identifier (`beta` → `rc`): change `vetra.prerelease` and push a
  commit with `Release-As: 2.0.0-rc.0`.
- A failed release run can be re-run: the tag and image already exist and are reused.
~~~~

- [ ] **Step 4: Run all tests and commit**

```bash
npm test 2>&1 | grep -E '^# (pass|fail)'
git add src/check.js README.md dist
git commit -m "feat: vetra-publish check, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected before committing: `# fail 0`.

---

### Task 15: Release v1, end to end, Sektar opt-in

Every step here pushes, tags or creates something outside this machine: ask the user before each one.

**Files:**
- vetra-publish: none (tags)
- Canary repo (user-created, e.g. `powerhouse-inc/vetra-publish-canary`): `.github/workflows/vetra.yml` via Vetra's setup PR
- Sektar (`/home/froid/projects/sektar`, branch `feat/vetra-publish`): `.github/workflows/vetra.yml`

**Interfaces:**
- Consumes: Tasks 1-2 deployed to production Vetra; the GitHub App permissions approved; the action at `v1`.

- [ ] **Step 1: Merge and tag the action**

Open the PR `feat/v1` → `main` in `powerhouse-inc/vetra-publish` (`gh pr create --fill`), wait for the Test workflow (tests and the dist check) to pass, merge it, then:

```bash
cd /home/froid/projects/vetra-publish && git switch main && git pull -q
git tag v1.0.0 && git tag v1 && git push origin v1.0.0 v1
```

- [ ] **Step 2: Canary: builds, the release PR, a release**

With the user: create the canary repo from `ph init` (it has `hosts/cli`), connect it as a Vetra App in the console, approve the GitHub App permissions, merge Vetra's setup PR. Then check, in order:

1. The push of the merge: the `publish` job reports a build `1.0.0-main.<n>` (or the version release-please proposes) and the Vetra Deploy bot opens a release PR `chore(main): release 1.0.0`.
2. The release PR's own run: a build `1.0.0-pr.<n>.<run>`.
3. Merging the release PR: tag `v1.0.0`, a GitHub release with the changelog, a run that reports `kind: release`.
4. In Vetra: `appReleases(appId)` (GraphQL) lists the release with the image digest, `run` = the GitHub run id, `packages`, `built.powerhouse` and `built.baseImage`; `docker buildx imagetools inspect cr.vetra.io/<namespace>/<app>:1.0.0` shows the same digest.
5. Re-running the release run from GitHub: it reuses the image, Vetra answers 200, nothing new is recorded.
6. Set release branches `next` in the App's settings, add `"vetra": { "prerelease": { "next": "beta" } }`, push a `feat!: …` commit to `next`: a release PR `2.0.0-beta.0` opens on `next`; a push to a feature branch gets `refClass BRANCH` and builds `<version>-<branch>.<run>` to `registry.dev.vetra.io`.

Expected: each check as described. A failure is a bug in this plan's tasks: fix it with a test first (superpowers:systematic-debugging).

- [ ] **Step 3: Sektar opt-in PR (not merged before the v1.0.9 rollout window, 2026-11-13 18:41 UTC)**

Sektar's licensed environments still follow the host image the old action builds on release tags (LATEST channel) until phase 3, so its workflow keeps the tag trigger for the old job only, and the old job publishes no packages on tags (vetra-publish already did):

```bash
cd /home/froid/projects/sektar && git fetch -q && git switch -c feat/vetra-publish origin/main
```

`.github/workflows/vetra.yml`:

```yaml
name: Vetra
on:
  push:
    branches: ['**', '!release-please--**']
    # Old path only, until phase 3: release tags build the host image that
    # licensed environments follow (LATEST channel).
    tags: ["v*"]
  pull_request:
    types: [opened, synchronize, reopened]
permissions: {}
concurrency:
  group: vetra-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  publish:
    if: "!startsWith(github.ref, 'refs/tags/') && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
      attestations: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
        with: { version: 12.10.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - uses: powerhouse-inc/vetra-publish@v1
        with:
          app-id: 43622402-be06-435a-bbfa-bb649b0d6244
  deploy:
    if: (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && (github.event_name == 'pull_request' || github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12.10.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - uses: powerhouse-inc/vetra-deploy-action@v1
        with:
          app-id: 43622402-be06-435a-bbfa-bb649b0d6244
          fusion-dockerfile: ${{ startsWith(github.ref, 'refs/tags/v') && 'hosts/cli/Dockerfile' || '' }}
          fusion-image-name: host
          # vetra-publish publishes the release's packages; publishing them
          # again from the tag run would fail.
          package-dirs: ${{ !startsWith(github.ref, 'refs/tags/') && '.' || '' }}
```

```bash
git add .github/workflows/vetra.yml
git commit -m "ci: publish with vetra-publish next to the old deploy path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Push and open the PR only when the user says so (`git push -u origin feat/vetra-publish && gh pr create --fill`). Expected on the PR: the `publish` job reports `1.x.y-pr.<n>.<run>`; the `deploy` job deploys the preview as today.

---

## Self-review

- **Spec coverage.** Section 3 branches, release PRs, version rules, build versions: Tasks 4, 7, 8. Release-PR merge tags and releases: Task 7 (`cutRelease`, release-please `createReleases`). Image naming and once-written tags: Task 9. Attestation: Task 13 (`action.yml`). Packages at the same version, dist-tags, production registry only on release branches: Task 10. `ci/registry-token`, `ci/releases` with the strict body: Tasks 8, 12. `requires`, `migrates`: Tasks 5, 11. `built`: Task 9. 14.1 Vetra GitHub App: Tasks 1, 8. 14.10 check: Task 14 (as `vetra-publish check`; `ph vetra check` deferred). 14.11 missing host reported: Task 5 (`hostDockerfile`). 14.17 run ordering: server-side (claim `runId`), the action only names builds with `run_number`. Section 15 GitHub App permissions and Sektar workflow: Needs-the-user, Task 15. Template on all branches + PRs: Task 2. SBOM: deferred, written back into the spec in Task 1.
- **Placeholder scan.** No TBD/TODO; every code step has the code; every command its expected output.
- **Names across tasks.** `decideVersion` uses `cutRelease(manifest, sha, {warn})`, `proposedVersion(manifest, prereleaseId)`, `manifestFor(github, branch, prereleaseId)`, `openGitHub({repository, token, branch})`, `releaseAtCommit({repository, token, sha})` as Task 7 defines them; `buildVersion(proposed, run)` reads `run.branch`, `run.pr`, `run.runNumber` from Task 6's `runContext`; prepare's outputs (`release-branch`, `production`, `image-ref`, `image-digest`, `powerhouse`, `base-image`, `notes`, `kind`, `version`) map one to one onto `stepState`'s `VETRA_*` variables in `action.yml`; config keys are `host`, `packageDirs`, `prerelease`, `requires`, `migrations`, `migrates` everywhere.
