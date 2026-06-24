# Vetra GitHub Auth

Vetra creates a private GitHub repo in the user's own account and pushes to it on their
behalf, with activity attributed to a Vetra bot. Authentication uses a GitHub App: the user
authorizes it once (a device flow, proxied through the backend so the browser never holds a
GitHub credential) and installs it, then the backend creates the repo and mints short-lived
tokens for each push.

The backend is a subgraph, `vetra-github-auth`, in this repo. Onboarding lives in the website
(vetra.to) and Git operations live in the agent (ph-clint); both are separate repos and are
described here only as contracts.

## Tokens

A GitHub App issues two token types:

- User access token: acts as the user. Obtained via the device flow, which the backend runs
  on the user's behalf (needs only the app's public `client_id`, no secret). Used once at
  onboarding to discover the installation and create the repo, then discarded. Never returned
  to the client.
- Installation access token: acts as the bot. Minted by the backend by signing a JWT with
  the app private key. Scoped to the installation, lasts ~1h, re-minted on demand. This is
  what the agent pushes with, and what gives bot attribution.

## Onboarding

Onboarding runs in the browser **at studio-environment creation** (vetra.to), where the user
already has a Renown session. Every call below carries the user's Renown bearer token; the
backend derives the caller's `did:pkh` from it and keys the connection on **(that DID, the
environment)** — one repo per environment. The browser never talks to GitHub directly.

1. The browser calls `startGithubDeviceFlow`. The backend calls GitHub
   (`POST /login/device/code`) with the app's public `client_id` and returns a `user_code`, a
   `verification_uri`, the `device_code`, and the poll `interval`/`expires_in`.
2. The browser shows the `user_code` / opens the `verification_uri`; the user authorizes the
   app on github.com (and installs it if they have not).
3. The browser polls `connectGithub(deviceCode, repoName, environmentId)`. The backend exchanges the
   `device_code` for a user access token server-side, and with that token:
   - lists the user's installations (`GET /user/installations`) and matches ours by `app_id`
     to get the installation id; errors `APP_NOT_INSTALLED` if none (the browser sends the
     user to the install page, then resumes polling).
   - creates a blank private repo (`POST /user/repos`); errors `REPO_ALREADY_EXISTS` on a
     name clash.
   - stores `(did, environmentId) -> installation_id, repo_full_name` and discards the user token.

   While the user has not finished authorizing, the exchange returns `AUTHORIZATION_PENDING`
   or `SLOW_DOWN` and the browser keeps polling at `interval`; `DEVICE_CODE_EXPIRED` and
   `ACCESS_DENIED` end the flow.

The flow is proxied through the backend because a browser cannot run the device flow itself —
GitHub's OAuth token endpoints send no CORS headers — and must never hold the app's client
secret. The device flow needs only the public `client_id`, so the backend brokers it and the
browser only ever makes authenticated GraphQL calls.

The repo must be created blank, not from a template: a blank repo created with the app's
user token is automatically added to the app's access list (even under a "selected
repositories" install), but a template-created repo is not. The repo is created empty (no
commits, no branch); the agent pushes the working tree as the first commit.

The backend discovers the installation from the user token rather than accepting an id from
the client, so there is nothing for a caller to forge.

## Pushing

The agent (ph-clint) acts as the user via a **delegated** Renown identity provisioned at env
creation: the user's signer authorizes the agent's DID for their Ethereum address, and the
credential is stored in the tenant secret store. The agent's bearer token then resolves to the
same `did:pkh`, so `getPushToken(environmentId)` finds the connection. Only the user's address
(in the credential) matters; the signing device differs from the browser.

The agent calls `getPushToken(environmentId)` (Renown bearer). The backend mints a ~1h installation token
for the caller's installation and returns it. The agent uses it as the Git credential
`https://x-access-token:<token>@github.com/<owner>/<repo>.git`, holds it in memory, and
re-fetches on expiry. Commits are authored under the bot identity (Git `user.name` /
`user.email` set to `<app-slug>[bot]` / `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`).

If the app has been uninstalled, the token mint fails (401/404). The backend detects this in
`getPushToken`, deletes the stored row, and returns `REINSTALL_REQUIRED`, which prompts the
user to onboard again. There is no webhook.

## Subgraph

`vetra-github-auth` follows the `vetra-access-codes` pattern: Renown-authenticated resolvers
keyed to the caller's `did:pkh` **and the studio environment**, backed by a Postgres table in
its own namespace. One row per (user, environment): `user_did`, `environment_id`,
`installation_id`, `repo_full_name`, `created_at` — a user gets one repo per environment. No
tokens are stored.

Operations (all require an authenticated caller, else `UNAUTHENTICATED`):

- `startGithubDeviceFlow`: begin device authorization; returns `{ deviceCode, userCode,
  verificationUri, expiresIn, interval }`.
- `connectGithub(deviceCode, repoName, environmentId)`: exchange the device code, then
  discovery + repo creation + persist, bound to environmentId. Errors `AUTHORIZATION_PENDING` /
  `SLOW_DOWN` (keep polling), `DEVICE_CODE_EXPIRED`, `ACCESS_DENIED`, `APP_NOT_INSTALLED`,
  `REPO_ALREADY_EXISTS`.
- `myGithubConnection(environmentId)`: whether the caller is connected for that environment,
  and the repo details.
- `getPushToken(environmentId)`: mints an installation token for that environment's
  installation; `NOT_CONNECTED` if none; `REINSTALL_REQUIRED` if the app was uninstalled.

Error codes are surfaced as `errors[].extensions.code` on a `GraphQLError` (the same
string is also set as the `message`, so a client can read either). Clients match on
`extensions.code`.

GitHub calls live in `github-app.ts`: `startDeviceFlow`, `exchangeDeviceCode`,
`findInstallationId`, `createRepo`, and `mintInstallationToken` (via `@octokit/auth-app`). All
but minting use `fetch`; the device-flow and REST calls use the public `client_id` / the user
token, and minting uses the private key.

## Secrets

The backend needs `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_PRIVATE_KEY`, read
from the environment (a k8s secret in deployment). The `client_id` is public (it is used for
the device flow) but is app-level config alongside the others. There is no GitHub *client
secret* — the device flow does not need one. These are single app-level values, not
per-tenant, so they do not go in the per-tenant secrets store (`vetra-cloud-secrets`), and the
private key must never enter a document model or the sync layer.

The private key is PKCS#1 as GitHub issues it; Node signs with it directly. A single-line
env value with `\n` escapes is un-escaped on load.

No tokens are persisted anywhere. The user access token is used during the `connectGithub`
request and discarded; the `device_code` lives only in the browser during onboarding.
Installation tokens are cached in memory by `@octokit/auth-app` for their ~1h life. The stored
row holds only identifiers (DID, installation id, repo name), none of which grant access
without the private key.

## Decisions

- Onboarding lives in the website (vetra.to, browser), not a CLI: the browser already holds a
  Renown session, and the established pattern there (the `vetra-access-codes`/invites module)
  is Renown-authenticated GraphQL against the cloud switchboard. The onboarding UI mirrors it.
- Backend-proxied device flow over the OAuth web (redirect) flow: the device flow needs no
  client secret and keeps the browser inside the GraphQL-over-Renown-bearer pattern (no
  redirect/callback route, no secret in the browser, no CORS problem).
- The backend does the device-code exchange, discovery, and repo creation, not the client.
  The user token is only ever at the backend, and discovery removes any client-supplied id.
- One repo **per environment**: a user can create several studio environments, each its own
  repo; connections are keyed by `(user_did, environmentId)`.
- The agent acts as the user via a **delegated** Renown identity provisioned at env creation
  (the user's signer authorizes the agent's DID for their address; stored in tenant secrets),
  so it resolves to the same `did:pkh` and pushes to the connection created at onboarding.
- Bot attribution: the agent pushes with the installation token and commits as the bot.
- Blank repo only (templates do not auto-grant; confirmed in GitHub docs and community
  discussion #72593).
- Repo name is supplied by the client.
- No webhook; revocation is handled in `getPushToken`.
- Runtime is Node (`node:24-alpine`), so the PKCS#1 key works directly with no conversion.

## Status

Built and tested in this repo: the subgraph (including the backend-proxied device flow —
`startGithubDeviceFlow` and `connectGithub` via `deviceCode`), `github-app.ts`, the DB layer,
and unit tests for the DB helpers and the resolver branches (24 tests). `tsc` and `eslint`
clean.

Revised 2026-06-18: onboarding moved from a CLI to the browser (vetra.to); the GitHub device
flow is now proxied through the backend (CORS + no client secret in the browser);
`connectGithub` takes a `deviceCode` instead of a `userAccessToken`.

Not done:

- End-to-end run against a real GitHub App, which needs the app registered (with Device Flow
  enabled) and `GITHUB_APP_*` provided. This would confirm the blank-repo auto-grant in
  practice.
- The vetra.to onboarding UI (start device flow, show the code, poll `connectGithub`) and the
  ph-clint agent work (`getPushToken`, credential helper, bot commit identity), both in their
  own repos.
- The repo URL field on the product document model.

## Ownership

- Wouter: register and configure the GitHub App — **enable Device Flow** and provide the
  `client_id`, app id, and private key; add the repo URL field to the product document model.
- Ozriel: post the app setup instructions to the team channel.

## Contracts for other repos

vetra.to (onboarding UI): calls `startGithubDeviceFlow`, shows the user code, and polls
`connectGithub(deviceCode, repoName)` — all with the in-session Renown bearer against the
cloud switchboard, reusing the invites/access-codes client pattern. Never talks to GitHub
directly.

ph-clint (agent): authenticates to Renown as the same user (a one-time `@renown/sdk/node`
login), calls `getPushToken` (Renown bearer) on first push and on expiry, holds the token in
memory (preferably via a Git credential helper so it never lands on disk), handles
`REINSTALL_REQUIRED` by prompting re-onboarding, and sets the bot commit identity.
