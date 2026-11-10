# App release rollout, phase 1: as built

Companion to `2026-11-10-app-release-rollout-design.md` (the design) and `../plans/2026-11-10-app-release-rollout-phase-1.md` (the plan). Phase 1 implements design sections 4.1 to 4.6. This file records where the code differs from those two documents, what is known not to be covered, and what to check before gating is switched on. Phases 2 (safe apply) and 3 (console) should read it first.

## Where the code differs from the design and plan

### API and model
- The publisher and holder API is a new GraphQL root, `vetraReleases`, not new fields on `vetraPublisher` / `vetraSubscriptions` (existing contract tests pin those field lists). `PublisherEnvironment` gains `runningVersion`, `isCanary`, `update` through `extend type`.
- `managedBy` on the environment document has a fourth field, `services` (the service types the template declares): the reducer cannot read the template. There is no operation that clears it.
- `environment_updates` has an extra column, `forced_at`.
- `AppRollout.promotedBy` is the promoter's DID.
- Design 4.6 is not applied as written: `DEPLOYMENt_FAILED` is the environment model's real enum value. `fusion-auto-update.ts` pins its status set to the model's type instead.

### The gate
- Admission (read "is another update of this app applying", then write) runs under a per-app, transaction-scoped Postgres advisory lock. Every status change of an update is a guarded transition that reports whether it won; a lost start rolls the whole decision back.
- A gated customer's rollout for the version it wants is the newest ACTIVE, PAUSED or COMPLETE rollout of that version. Only PAUSED holds. So a customer that missed a rollout (asleep, or its chain ended and resumed) catches up under the COMPLETE rollout, with the original deadline honoured. A failure of such a late update is FAILED on that environment and pauses nothing.
- A version that was never promoted is held with no update row. Turning gating on therefore freezes an environment that is behind LATEST until that version is promoted (promoting the version LATEST already points at is allowed).
- An update closed because its environment ended is revived when the chain is provisioned again.
- A timestamp that does not parse holds an update; it never releases one. A paused rollout's hold reason names the pause.
- Hold reasons are logged once per environment and reason (`[licensing] …`, info level).
- A held provision gives its re-template budget back only when it dispatched nothing.
- On an error from dispatching an admitted update, the update is handed back only if the document's FUSION version is still the old one; otherwise it stays APPLYING for the tracker.
- In keeper dry run (`LICENSING_DRY_RUN`, on by default) the gate is not wired at all and a log line says so. Release gating is inactive there.

### Tracking and completion
- The tracker first closes the open updates of environments that are no longer live.
- A rollout completes when it has no PENDING or APPLYING update, LATEST points at its version, and no live customer environment that the keeper could provision now is behind. An environment with no document, or in a status `provisionChain` refuses, does not block completion.
- A document read that fails counts as "not observed": the update's timeout still applies.
- `LICENSING_UPDATE_TIMEOUT_MS` is parsed strictly (digits only, above 0), default 1 200 000.

### Publisher operations
- Promote is forward-only: a version provably older than LATEST is refused.
- STAGING is brought up to LATEST (when it has no pointer or is provably older) both when a canary is marked and when the app is gated.
- Leaving gating (GATED to AUTO) is refused while a rollout is PAUSED or has PENDING or APPLYING updates. On success the app's canaries are unmarked, and the canaries are unmarked before AUTO is saved.
- Unmarking a canary closes its PENDING update that has no rollout.
- Policy, canary and promote decisions are serialised per app with an in-process lock.
- Force uses a guarded transition and clears the stored error.

### Routes around the gate that phase 1 closed (not in the plan)
- FUSION auto-update skips an environment whose marker declares FUSION, and `bumpEnvToTag` (update to latest, rollback, channel notification) leaves out services the template declares.
- A managed environment cannot be attached to or adopted by an App, and App deploys refuse a managed target.
- The machine API's `applyEnvironmentTemplate` resolves a canary on its channel, as the keeper does.

### Scope of the marker
The keeper marks every live licence-chain environment as managed, whatever its app's release policy. So with dry run off, every licensed environment gets the holder locks, is skipped by FUSION auto-update, is refused by the release endpoints for declared services, and cannot be attached to an App. This is intended (confirmed during review on 2026-11-10); it does mean an AUTO app's environments are not "exactly as before" in those respects.

## Known limitations

- **The template locks are not a security boundary.** The reducers treat an action without a user signer as a system action, and an action that reaches the server's reactor client unsigned is signed as system. A holder with document admin rights can bypass the locks through the document API. Closing this needs a permission-model change (for example holders drop from ADMIN to WRITE on licensed environments).
- **A warm-pool claim can record a held version as applied.** When a warm environment's FUSION version cannot be ordered against the template's at claim time, the claim still records the template hash. A fix needs either a "held" sentinel hash (visible through the API) or a change to the claim's crash-recovery check.
- **A customer asleep with a PENDING update keeps its rollout ACTIVE** and blocks leaving gating until it wakes. Promoting a newer version supersedes the rollout and is the way out.
- **Promote, then leave gating at once:** if the keeper has not yet created the customers' PENDING rows, leaving gating succeeds and every customer moves on the next ticks under AUTO rules, past the notice.
- **No automatic revert or restore.** A failed update leaves the environment on the new version, marks the update FAILED and pauses the rollout. Force or resume of a FAILED update whose environment already runs the version moves nothing; it settles once the environment is READY again. Phase 2 covers recovery.
- **READY is trusted.** Success is "READY on the target version" as reported by the environment document. Whether the new image is really serving is phase 2's probe work.
- **Cost of holding.** A held environment is re-provisioned (document read, gate transaction, row write) on every keeper tick while it is held.
- **Single replica assumed** for the in-process locks (chain lock, release lock). The gate's advisory lock is database-level, but it has never been exercised under real contention: the tests run on single-connection PGlite.
- **One FUSION image per app template** is assumed by the release service. A gated app whose template pins FUSION without an artifact name is held as "not promoted" indefinitely.
- **`managedBy` cannot be cleared**, and an environment attached to an App in the short window before the keeper marks it (the sync skips DRAFT documents) can take one deploy.
- **The publisher page reads three things per environment** for the new fields, and `myEnvironments.managedBy` is one query per environment.

## Before gating is switched on

1. Confirm on staging that the keeper's unsigned actions pass the template locks, that is, that the server's reactor client signs with no user address. The existing system-only operations rely on the same condition.
2. Confirm an older console build tolerates environment documents that carry `SET_MANAGED_BY` operations.
3. Exercise two admissions for one app at the same time against real Postgres (the keeper and the machine API).
4. Run the licensing and read-model migrations against a copy of the production database.
5. Switch `LICENSING_DRY_RUN` off for the environment where gating should work.
6. Rollback runbook: switch every app back to AUTO before rolling this code back. Older code ignores the policy and the canary channel, so a gated app would silently lose its gate.

## Not investigated

Why the environment `fair-bull` stays on an older build. The keeper's logs were not available. The "held but marked applied" bug fixed here, and the warm-claim case above, are both ways an environment can end up in that state.
