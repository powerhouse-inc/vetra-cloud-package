# Studio Products — bulletproof, fast, nice UX

**Goal:** The Vetra Studio "products" view (claim/create → see it) is correct, fast, and polished. A user always sees exactly their own products, immediately after creating one, with a clean loading/ready UX.

## Root causes (systematic-debugging)
1. **Pool leak:** `myEnvironments(MINE)` returns `owner == me OR owner IS NULL`. The warm pool created many `owner=null` envs, so the query returns the whole pool (this user: 17 rows, 4 theirs). Client-filtered today, but wire-bloated and privacy-leaky.
2. **"Can't see just-claimed product" (the reported bug):** the client filter keeps an env if `owner==me || (owner==null && createdBy==me)`. A *claimed* warm env has `createdBy=null` and `owner` set asynchronously by the claim's `SET_OWNER`. During the read-model propagation lag, neither clause matches → the just-claimed product is invisible. (Cold-created envs avoided this because `createdBy=me` was set immediately.)
3. **Slow scan:** `scanProducts` does sequential N+1 `fetchEnvironment` per env + endpoint + brand fetches.

**Key enabler:** the claim sets `claimedBy = caller` **synchronously** (same transaction as `poolState=CLAIMED`, `pool-db.ts`), in the `environments` read-model. Scoping by `owner OR claimedBy` is therefore both leak-free and lag-free.

## Design

### A. Backend — `myStudioProducts` query (vetra-cloud-package, `vetra-studio-pool` subgraph; runtime-deployable, no switchboard image rebuild)
- `myStudioProducts: [StudioProduct!]!` — authenticated caller only. SQL scope: `lower(owner) = me OR lower(claimedBy) = me`. Never returns `owner IS NULL` → no leak; `claimedBy` synchronous → just-claimed shows instantly.
- Restrict to studio envs (label `Vetra Studio` / a CLINT `vetra-agent` service) and exclude dead/terminal statuses (`TERMINATING/DESTROYED/ARCHIVED`).
- `StudioProduct { envId, subdomain, prefix, label, status }`. `status` resolved server-side from env `status` + clint-runtime-endpoint announcements the observability subgraph already records (`PROVISIONING|READY|...` → product status). One round-trip; no N+1.
- Brand is NOT resolved server-side (external per-tenant fetch) — stays a lazy client fetch fired only when `status=ready` (keeps the existing DNS negative-cache safeguard).

### B. Frontend — `vetra.to`
- `fetchMyStudioProducts(token)` client in `modules/cloud/graphql.ts`.
- `useStudioProducts` calls it (one polled query, 30s) — removes the `myEnvironments`→`filterByScope`→`scanProducts`/`findStudioAgents` path for this view.
- **Optimistic create:** `createProduct` returns the claimed env; show it immediately as a `provisioning` card (merge with the next poll by `envId`).
- **UX:** skeleton cards on first load; status badges (provisioning → ready); friendly empty state; per-card graceful fallback (never drop a card on a transient error); clean grid/card visual polish.

### C. Bulletproofing
- Correctness server-side (owner OR claimedBy); independent of client filtering or propagation timing.
- Degrade gracefully: a product whose readiness can't be determined renders as `provisioning`, not missing.

### D. Validation
- Clean slate: delete the test user's (`0x2BbEA…3aC6`) studio envs (admin).
- e2e: claim → product card appears immediately → transitions to ready (extend `e2e-claim`, plus a focused check).

## Out of scope
- The `myEnvironments(MINE)` `owner IS NULL` behavior also backs the `/environments` "Unclaimed" tab; leave that path untouched. Only add the dedicated `myStudioProducts` query.
- Brand/screenshot pipeline unchanged.
