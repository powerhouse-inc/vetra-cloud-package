# Licence-driven provisioning — open items carried out of slice 1

Companion to `2026-10-06-license-driven-provisioning.md` and its spec. Everything
here was found during implementation or review, consciously deferred, and
recorded so it is not rediscovered the hard way. Grouped by what must happen
before which gate.

## Must be settled before `LICENSING_KEEPER_ENABLED=true` in production

**1. `approveChanges` is rejected from `STOPPED`.**
Housekeeping sleeps idle environments by design. A licence-type template change
against a slept environment therefore retries forever. The fix is one action
(`wakeEnvironment` is legal from `STOPPED`), but whether a template change should
wake a sleeping customer environment and start billing compute is a product
decision, not a bug fix. Blast radius is wide: for a free-tier population a single
template bump would wedge every slept environment at once.

**2. `templateHash` covers fields `renderUpdateActions` never applies.**
The hash includes `baseDomain`, `packageRegistry` and `size`; the update path
applies none of them, so a row can record a convergence that never happened.
`setDefaultPackageRegistry` exists and would close `packageRegistry`;
`genericBaseDomain` has no setter at all (only `initialize`), so it needs either a
documented "immutable after create" note or exclusion from the hash.

**3. There is no allow-list store, and `NotOnAllowListError` is dead in production.**
`index.ts` wires `isOnAllowList` to `async () => true`. Reviewed and accepted for
slice 1: the app is derived from the caller's App identity and a licence type must
belong to that app, so a caller can only mint licences for its own types against
its own quota. The one new capability is choosing the holder address — a boundary
between an app and its users, not between an app and the platform. Keep the seam
and its test, but nothing would catch a regression in the real wiring, and this
must get a real store before an allow list is advertised as a feature.

## Should be closed before third parties write licences directly

**4. ISO-8601 timestamps are compared lexically with no enforcement.**
`transitions.ts` compares `start`/`end` against `nowIso` as strings, and the
`AppOwnerLicense` reducer compares `end < start` the same way. The `DateTime`
scalar maps to a bare `string` with no normalisation, so a mixed-offset value is
representable: `start: "2026-01-01T02:00:00+02:00"` with `end: "2026-01-01T00:30:00Z"`
is a valid ordering that is rejected as `END_BEFORE_START`. It holds today only
because every producer is our own `toISOString()` call. The right fix is one
documented invariant — all `DateTime` values in this slice are UTC `Z` ISO-8601 —
enforced once at the GraphQL boundary, **not** `Date.parse` scattered per reducer.

## Known, accepted, and cheap to revisit

**5. Reads scan by document type.**
`reads.ts` answers every query with `reactorClient.find({ type })` plus an
in-memory filter, so each resolver call and each keeper tick is O(all documents of
that type) rather than O(one app). Deliberate: licences can be issued by achra and
never pass through this subgraph, so an index written at our own mutation time
would miss them. The escape hatch when this hurts is a processor-backed relational
index — `processors/vetra-cloud-environment/factory.ts` is the worked example.

**6. `provision.ts` creates the environment document before claiming the row.**
A `claimRow` rejection after a successful `envs.create()` orphans a document, one
per tick on a flaky database. Inherent to writing two systems without a
transaction; the window is far smaller than the original design's.

**7. A malformed document is skipped silently.**
`reads.ts` has no logger, so a licence with an unrecognised status disappears from
the keeper's view without a trace. Skipping is correct — `LicenseStatusName` is a
closed union — only the silence is the gap.

**8. A null or malformed template hashes as the empty template.**
All broken licence types therefore share one hash. No wrong decision follows today
(a broken type's licence mismatches any real converged hash, goes to `toApply`, and
provisioning then refuses without touching the existing environment). A sentinel
such as `"invalid-template"` would be clearer.

**9. Test fakes that under-constrain.**
`license-gateway.test.ts` returns its operation regardless of `sinceRevision`, so a
gateway that dropped the revision filter would still pass; `reads.test.ts`'s paging
fake never exercises the filter path. Both wrap logic copied from the proven
`envs.ts`, which is why they were accepted.

**10. `issuePublisherGrant` accepts a fractional or negative `validityDays`**
and produces an odd but still valid timestamp. Reject upstream if it matters.

## Verification that has not been run

The spec's definition of done — the eight-step manual walkthrough at the end of
the plan — has **not** been performed. It requires `LICENSING_KEEPER_ENABLED=true`
and `LICENSING_DRY_RUN=false` against a real switchboard, which provisions real
environments. Items 1 and 2 above are the ones most likely to bite during it.
`LICENSING_SCAN_INTERVAL_MS` defaults to 60s; lowering it makes the three
"wait one keeper interval" steps far less tedious.
