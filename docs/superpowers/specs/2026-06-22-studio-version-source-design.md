# Backend-Sourced Studio CLI Version — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming) — pending spec review
**Repos touched:** `vetra-cloud-package` (studio-pool subgraph),
`vetra.to` (studio create flow)

## Goal

A new studio always provisions the **current** vetra-cli version the backend
intends, even when the user's browser is running a months-old cached
`staging.vetra.io` bundle.

## Problem / Root cause

The cold-provisioning path embeds a **bundled** version constant into signed
actions:

- `vetra.to/modules/cloud/studio/constants.ts:15` —
  `STUDIO_AGENT_VERSION = '0.0.1-dev.23'` (baked into the JS bundle).
- `vetra.to/modules/cloud/studio/use-create-studio-environment.ts:68,76` —
  cold provisioning calls `addPackage({ version: STUDIO_AGENT_VERSION })` and
  `enableService({ ... version: STUDIO_AGENT_VERSION ... })`.

A user on a cached bundle therefore cold-provisions the **stale** CLI version.

**Correction to earlier investigation:** the *claim* path is already
backend-authoritative — `claimStudioEnvironment` takes **no** version arg
(`subgraphs/vetra-studio-pool/resolvers.ts:28-35`) and returns whatever the
backend's current pool holds. The mismatch is **only** in cold provisioning,
which is reached when (a) the warm pool is empty / has no server-side key
(`use-create-studio-environment.ts:51-57` falls through), or (b) the user enters
a manual Anthropic key (skips claim entirely, `:51` guard). That is exactly the
path Teo/Dracaena hit → old CLI.

## Approach (chosen: A, version-only)

Backend exposes a **live** query returning the current studio CLI version,
sourced from the same `cfg` the keeper uses; the frontend fetches it and
overrides only the version when building cold-provisioning actions. Because the
response is live (not bundled), even a stale cached frontend provisions the
current version. The version-only scope was chosen deliberately — registry,
package, serviceCommand, and size stay sourced from `constants.ts` for now.

## Components & data flow

1. **Backend query (vetra-studio-pool subgraph)**
   - Add a query returning the current version, e.g.
     `query { VetraStudioPool { config { version } } }`.
   - Source: the same config the pool keeper reads —
     `subgraphs/vetra-studio-pool/config.ts:27` (`env.STUDIO_POOL_VERSION ??
     DEFAULTS.version`), surfaced via `index.ts:150` (`cfg.version`).
   - Wire into `schema.ts` + `resolvers.ts` alongside the existing
     `VetraStudioPool` namespace. No auth required (version is non-sensitive);
     match the existing namespace resolver shape (`resolvers.ts:22-38`).

2. **Frontend fetch (vetra.to)**
   - In `use-create-studio-environment.ts`, before the cold-provisioning block
     (`:59` onward), fetch the backend version (small GraphQL call, reuse the
     studio switchboard client used for `claimStudioEnvironment` in
     `modules/invites/lib/client.ts`).
   - Use the fetched version in place of `STUDIO_AGENT_VERSION` at `:68` and
     `:76`. Fall back to the `STUDIO_AGENT_VERSION` constant if the query fails
     (offline / older backend), so the flow degrades safely.
   - Optionally cache the fetched version for the session (React Query) to avoid
     refetching on retries.

## Error handling / edge cases

- **Query fails / older backend without the field:** fall back to the bundled
  `STUDIO_AGENT_VERSION` constant — no worse than today.
- **Claim path unchanged:** still backend-authoritative; this change only
  affects the cold fallback and the manual-key path.
- **Stale bundle predating the query:** a frontend old enough to not even call
  the new query still sends the old constant. This is inherent to client caching;
  the fix protects every client from the deploy of this change onward. (A
  server-side override of cold-provisioning actions was considered as
  defense-in-depth but rejected — the actions are user-signed; rewriting them is
  awkward, and the claim path already covers the common case.)

## Testing

- **Backend (TDD):** resolver test — the new query returns `cfg.version`; assert
  it tracks `STUDIO_POOL_VERSION` via the config loader.
- **Frontend (TDD):** test `useCreateStudioEnvironment` cold path uses the
  fetched version in the `addPackage`/`enableService` inputs, and falls back to
  the constant when the fetch throws.
- **Live (staging):** with a deliberately stale `STUDIO_AGENT_VERSION` constant,
  force cold provisioning (empty pool or manual key) and confirm the created env
  pins the **backend** version, not the constant.

## Out of scope

- Returning the full provisioning descriptor (registry/package/serviceCommand/
  size) — deferred; version-only chosen.
- Server-side rewriting/override of signed cold-provisioning actions.
- Frontend bundle cache-busting (orthogonal; doesn't help already-cached clients).
