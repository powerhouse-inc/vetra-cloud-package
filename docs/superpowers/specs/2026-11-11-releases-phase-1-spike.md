# Releases phase 1 — spike findings

Date: 2026-11-11. Task 1 of the "Releases phase 1 (server)" plan. Answers the
two external unknowns of
[the design](./2026-11-11-app-releases-and-instances-design.md): what Renown's
CI workload token carries (and for which branches), and how Vetra verifies a
GitHub artifact attestation in Node.

Ruling for this spike: no outward side effects (no test repo, no App install,
no pushed image, no workflow run). Step 1 is answered from Renown's source;
Steps 2-3 use an existing public attestation, read with `gh` and verified with
`sigstore` locally. What that leaves unproven is listed at the end.

## 1. Renown CI tokens

Source: `powerhouse-inc/renown-package`, branches `main` and `staging` and tag
`v1.13.0` (the version pinned in `powerhouse-k8s-hosting`
`tenants/renown/powerhouse-values.yaml:73`) are identical for the files below.

### A push to `next` gets no token

`subgraphs/renown-workload/core/refs.ts:22-41` (`classifyRun`) trusts only:

| Event | Ref | refClass | prNumber |
|---|---|---|---|
| `push`, `workflow_dispatch` | `refs/heads/<productionBranch>` (exactly) | `PRODUCTION` | null |
| `push` | `refs/tags/v<digit>…` | `RELEASE` | null |
| `pull_request` | `refs/pull/<n>/merge` | `PREVIEW` | n |

Anything else returns null, and `http/handlers.ts:120-125` answers
**403 `access_denied`** "Only push/workflow_dispatch on the production branch,
push of v* tags and pull_request runs may deploy". `productionBranch` is a
single string per workload identity (`core/types.ts:13`; settable through
`updateWorkloadIdentity(productionBranch)`, `schema.ts:49-53`). The tests pin
it: `tests/core.test.ts:97` rejects `push` on `refs/heads/feature`.

So for an app whose production branch is `main`:

- push to `main` → token, `refClass: PRODUCTION`, `ref: refs/heads/main`,
  `eventName: push`.
- push to `next` → **no token** (403).
- push of tag `v2.0.0-beta.1` → token, `refClass: RELEASE`.
- PR (into any branch, `next` included) → token, `refClass: PREVIEW`,
  `ref: refs/pull/<n>/merge`, `prNumber: n`. Previews are also refused the
  production registry audience (`refs.ts:47-57`).
- Maintenance branches (`1.x`) → no token.

The design's prerelease and maintenance branches (section 3) therefore need a
Renown change: a list of release branches per identity (or a branch pattern),
classified as their own refClass. Added to the design's section 15.

### The claim

`core/types.ts:47-61` (`VetraWorkloadClaim`), filled at
`http/handlers.ts:144-156` from the verified GitHub OIDC token
(`core/github.ts:144-165`):

| Field | Value | Note |
|---|---|---|
| `ref` | OIDC `ref` | always present |
| `refClass` | `PRODUCTION` / `RELEASE` / `PREVIEW` | |
| `sha` | OIDC `sha` or null | |
| `repository` | `owner/name` | |
| `repositoryId` | numeric id **as a string** | |
| `runId` | OIDC `run_id` or null | **a string**: Renown passes GitHub's `run_id` through `optionalString`, which keeps a string and stringifies a number (`github.ts:65-69,159`); there is no digits-only check, so Vetra must validate it (e.g. `/^[1-9][0-9]*$/`) before `BigInt`. GitHub sets `run_id` on every Actions run. |
| `runAttempt` | OIDC `run_attempt` or null | string |
| `actor` | OIDC `actor` or null | |
| `prNumber` | number or null | number for PREVIEW only |
| `eventName` | OIDC `event_name` | `push`, `workflow_dispatch` or `pull_request` |
| `workflowRef` | `job_workflow_ref` ?? `workflow_ref` | e.g. `owner/repo/.github/workflows/vetra.yml@refs/heads/main` |

Token TTL: 600 s (`http/handlers.ts:11`). Vetra's parser
(`vetra-cloud-package` `subgraphs/vetra-apps/auth.ts:20-32, 67-85`) keeps every
field **except `workflowRef`**; it keeps `runId` as a string. Later tasks:
compare run ids as `BigInt(claim.runId)` (they exceed 2^31; 40384165451 in the
fixture), reject a claim without `runId`, and add `workflowRef` to
`parseVetraClaim` to bind the attestation's signing identity to the run that
reports it (section 3 below).

`runId` is GitHub's global run id, not the per-workflow `run_number`. Build
versions (`1.4.0-main.37`) can keep using `run_number` (the action knows it);
ordering (14.17) uses the claim's `runId`, which only the server trusts.

## 2. The attestation fixture

No `powerhouse-inc` repo has GitHub artifact attestations
(`gh search code` for `attest-build-provenance` / `attest` in the org: none;
`sektar`'s `vetra.yml` and `desktop.yml` have no attest step; the private
`knowledge-vault-landing` sets `provenance: false`). The fixture is a public
repo's:

| | |
|---|---|
| Repo | `cli/cli` (**public**, repository id 212613049) |
| Subject | `gh_2.103.3_linux_amd64.tar.gz`, `sha256:4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d` (one of 21 subjects) |
| Fetched with | `gh api "repos/cli/cli/attestations/sha256:4c80…d91d?predicate_type=provenance"` |
| Predicate | `https://slsa.dev/provenance/v1`, buildType `https://actions.github.io/buildtypes/workflow/v1` |
| Signing identity (cert SAN) | `https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Commit | `63837fb778d6a39f02be0ce76ff89f2bc8d74bdc` |
| Run | `https://github.com/cli/cli/actions/runs/40384165451/attempts/1`, `workflow_dispatch` |
| Log | Sigstore public good (Rekor entry, no TSA) |

Saved as `subgraphs/vetra-apps/__tests__/fixtures/attestation-bundle.json`.
Two more fixtures make the verifier testable offline and on GitHub's own
instance:

- `attestation-bundle-github-instance.json`: the same release's **GitHub
  release attestation** (`https://in-toto.io/attestation/release/v0.2`,
  SAN `https://dotcom.releases.github.com`), signed by **GitHub's Sigstore
  instance** (`fulcio.githubapp.com`, RFC 3161 timestamp from
  `timestamp.githubapp.com`, no Rekor entry, no SCT) — the same trust root and
  bundle shape as a private repo's attestation.
- `github-trusted-root.jsonl`: `gh attestation trusted-root` output, two
  lines: Sigstore public good, then GitHub (`fulcio.githubapp.com`).

### Differences from what the plan assumed

1. **`attestations[0].bundle` is null.** The API now returns `bundle: null`
   and a `bundle_url` (a pre-signed Azure blob URL, ~1 h validity, no auth
   needed) whose body is **raw Snappy-compressed** bundle JSON (`.json.sn`).
   The server must handle both: use `bundle` when present, else fetch
   `bundle_url` and Snappy-decode (`snappyjs` `uncompress`). The fixture is
   the decoded JSON.
2. **`attestations[0]` is not necessarily the provenance.** For this digest
   it was GitHub's release attestation (initiator `github`). Query with
   `?predicate_type=provenance` (works: one result, initiator `user`) and
   still check `predicateType` after verification.
3. Paths confirmed: the cert is at `verificationMaterial.certificate.rawBytes`
   (bundle v0.3; `x509CertificateChain.certificates[0].rawBytes` is the v0.1/0.2
   shape), SAN via `new X509Certificate(der).subjectAltName`
   (`URI:https://github.com/…`). The commit is at
   `predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit` of the
   base64 DSSE payload, as assumed. The run is at
   `predicate.runDetails.metadata.invocationId`
   (`…/actions/runs/<runId>/attempts/<n>`); the workflow at
   `predicate.buildDefinition.externalParameters.workflow`
   (`{ref, repository, path}`).
4. The Fulcio certificate itself carries the same facts, asserted by Fulcio
   from the OIDC token rather than written by the workflow:
   `1.3.6.1.4.1.57264.1.13` source commit, `.1.14` source ref, `.1.15`
   repository id, `.1.20` event, `.1.21` run invocation URI (with run id),
   `.1.22` visibility (`public`). sigstore-js 3 does not expose these in its
   policy (only SAN and `issuer`); after verification the predicate is signed
   content, so reading it is sound. Reading the extensions needs an ASN.1
   parser (not done).

## 3. Verifying in Node

`sigstore@3.1.0` (`@sigstore/verify@2.1.1`, `@sigstore/tuf@3.1.1`), Node 24.

### Public repo (public-good Sigstore): verified

```ts
import { verify } from "sigstore";
await verify(bundle, {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI:
    "https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk",
});
```

`verify` resolves to `void` and throws on failure (e.g.
`UNTRUSTED_SIGNER_ERROR certificate identity error - expected …@refs/heads/main, got …@refs/heads/trunk`).

### Private repo (GitHub's Sigstore instance): verified on a GitHub-instance bundle

There is **no `trustMaterial` option** in `sigstore` 3's `VerifyOptions`
(`node_modules/sigstore/dist/config.d.ts`). Two ways work, both verified live
on `attestation-bundle-github-instance.json`:

**(a) `sigstore.verify` with GitHub's TUF repository**

```ts
await verify(bundle, {
  tufMirrorURL: "https://tuf-repo.github.com",
  tufRootPath: "github-tuf-root.json", // cli/cli pkg/cmd/attestation/verification/embed/tuf-repo.github.com/root.json
  tufCachePath: "/var/cache/vetra/tuf-github",
  tlogThreshold: 0,   // GitHub's instance writes no Rekor entry
  ctLogThreshold: 0,  // and has no CT log
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: "https://github.com/<owner>/<repo>/.github/workflows/vetra.yml@<ref>",
});
```

Without the thresholds: `TIMESTAMP_ERROR expected 1 tlog timestamps, got 0`.
With the default (public-good) root: `TIMESTAMP_ERROR timestamp could not be verified`.
Caveat: `sigstore.verify` does not expose `tsaThreshold` (defaults to 0), so
with `tlogThreshold: 0` nothing requires a timestamp. A bundle stripped of its
timestamp failed anyway, but with a `TypeError` (`reading 'clone'`), not by
policy. Do not rely on that.

**(b) Recommended: `@sigstore/verify` directly, explicit thresholds**

```ts
import { getTrustedRoot } from "@sigstore/tuf";          // or TrustedRoot.fromJSON(line) from github-trusted-root.jsonl
import { Verifier, toTrustMaterial, toSignedEntity } from "@sigstore/verify";
import { bundleFromJSON } from "@sigstore/bundle";

const githubRoot = await getTrustedRoot({
  mirrorURL: "https://tuf-repo.github.com",
  rootPath: "github-tuf-root.json",
  cachePath: "/var/cache/vetra/tuf-github",
});
const publicGoodRoot = await getTrustedRoot({ cachePath: "/var/cache/vetra/tuf" });

const onGithub = (bundle.verificationMaterial.tlogEntries ?? []).length === 0;
const verifier = onGithub
  ? new Verifier(toTrustMaterial(githubRoot), { tlogThreshold: 0, ctlogThreshold: 0, tsaThreshold: 1 })
  : new Verifier(toTrustMaterial(publicGoodRoot), { tlogThreshold: 1, ctlogThreshold: 1, tsaThreshold: 0 });
const signer = verifier.verify(toSignedEntity(bundleFromJSON(bundle)), {
  subjectAlternativeName: expectedIdentityUri,
  extensions: { issuer: "https://token.actions.githubusercontent.com" },
});
```

Choosing the root by bundle shape is safe: a certificate from one CA never
chains to the other root, so a wrong pick only fails. Results, all live:

| Bundle | Result |
|---|---|
| public fixture, right SAN + issuer | verified |
| GitHub-instance fixture, right SAN | verified |
| GitHub-instance, timestamps removed | `TIMESTAMP_ERROR expected 1 tsa timestamps, got 0` |
| either, wrong SAN | `UNTRUSTED_SIGNER_ERROR certificate identity error` |
| public, wrong issuer | `UNTRUSTED_SIGNER_ERROR invalid certificate extension` |
| DSSE payload altered | `SIGNATURE_ERROR signature verification failed` |
| both fixtures, roots from `github-trusted-root.jsonl` (`TrustedRoot.fromJSON` from `@sigstore/protobuf-specs`), no network | verified |

Production should load the roots through TUF (they rotate); tests use
`github-trusted-root.jsonl` to stay offline.

### What to check after the signature

The signature proves "a workflow run with identity SAN signed this statement".
Vetra then checks, against the report and the claim:

- SAN = `https://github.com/<claim.repository>/.github/workflows/vetra.yml@<claim.ref>`
  (or, simpler and stricter, `https://github.com/${claim.workflowRef}` once
  `workflowRef` is parsed). Note the ref in the SAN is the run's ref: PR builds
  sign as `…@refs/pull/<n>/merge`, tag runs as `…@refs/tags/v…`.
- `predicateType` = `https://slsa.dev/provenance/v1`.
- a `subject[].digest.sha256` equals the reported image digest.
- `resolvedDependencies[0].digest.gitCommit` = the reported commit = `claim.sha`.
- `runDetails.metadata.invocationId` contains `/actions/runs/<claim.runId>/`.

If `vetra.yml` becomes a reusable workflow in the action repo, the SAN is the
reusable workflow (`job_workflow_ref`), not the caller; the claim's
`workflowRef` follows the same rule, so comparing to it keeps working.

## 4. Not verified live

- That Renown issues or refuses tokens as read: no workflow ran. The answer
  comes from source plus its unit tests, at the deployed tag.
- A **private repo's workflow** provenance attestation. The GitHub-instance
  path was verified with GitHub's release attestation (same instance, same
  bundle shape, different SAN and predicate). Assumed, not seen: that a
  private repo's attestation carries no Rekor entry and no SCT, has an RFC 3161
  timestamp from `timestamp.githubapp.com`, and that its cert has issuer
  extension `https://token.actions.githubusercontent.com` and the workflow SAN.
- That the attestations API returns `bundle_url` (rather than `bundle`) for
  private repos, and which token scopes reading a private repo's attestations
  needs from Vetra (`attestations: read` on the GitHub App is expected).
- A container image subject (`subject-name` = `cr.vetra.io/…`): the fixture's
  subjects are release files. The bundle format is the same.
- Attestation through `actions/attest-build-provenance@v2` on a push to
  `next`: moot until Renown issues tokens for such branches.
