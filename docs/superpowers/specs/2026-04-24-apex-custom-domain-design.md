# Apex custom-domain routing + auto-DNS for owned zones

**Date:** 2026-04-24
**Status:** Approved for implementation

## Problem

Today, enabling a custom domain on a `vetra-cloud-environment` produces
hosts of the form `<service>.<customDomain>` — e.g. setting the domain to
`admin.vetra.io` exposes Connect at `connect.admin.vetra.io`, not at the
apex. Two consequences:

1. **No apex routing.** A user who wants Connect served directly at
   `admin.vetra.io` can't express that. The current doc model has a
   per-service `prefix` field, but the gitops template ignores it and
   hardcodes the service name.
2. **Manual DNS** — the UI tells the user to "add these A records to
   your DNS provider". For domains under `vetra.io` this is wrong:
   external-dns in the cluster already owns the zone (`--domain-filter=vetra.io`)
   and publishes records automatically from Ingress annotations.

Concrete driver: the team wants three environments on
`admin-dev.vetra.io`, `admin-staging.vetra.io`, `admin.vetra.io`, each
serving Connect at the apex. Creating these by hand in
`powerhouse-k8s-hosting` defeats the point of the vetra-cloud control
plane — it should be expressible through the vetra.to UI.

## Goals

- A single enabled service can be routed at the apex of a custom domain.
- Custom domains under an owned DNS zone (`vetra.io`) require **zero**
  manual DNS action.
- Domain uniqueness is enforced — two environments can't both claim the
  same host.
- Admin environments (`admin-dev.vetra.io`, `admin-staging.vetra.io`,
  `admin.vetra.io`) can be created entirely from the UI.

## Non-goals

- Multi-service apex ("Connect at `admin.vetra.io` AND Switchboard at
  `switchboard.admin.vetra.io`" simultaneously). Not needed yet; the
  design doesn't preclude it.
- Automatic DNS for domains outside `vetra.io`. External customer
  domains keep the current "you own the DNS" flow, but without any
  code path for them in the admin use case.
- Wildcard certs. Per-hostname `letsencrypt-prod` cert-manager flow is
  kept as-is.

## Design

### Document model: `apexService` on state

Add one nullable field on `VetraCloudEnvironmentState`:

```graphql
type VetraCloudEnvironmentState {
  ...
  apexService: VetraCloudEnvironmentServiceType  # nullable
}
```

Semantics: when `customDomain.enabled` is true **and** `apexService` is
set, the named service's primary ingress uses `customDomain.domain` as
its host (no prefix). Other enabled services are unaffected — they keep
`<prefix>.<subdomain>.vetra.io`. No `<prefix>.<customDomain>` ingresses
are generated under apex mode.

One new operation `SET_APEX_SERVICE(type: VetraCloudEnvironmentServiceType)`
with a matching nullable input. The reducer guards:

- If `type` is set but that service isn't enabled → `ServiceNotEnabledError`.
- Bumps `status` to `CHANGES_PENDING`.

`SET_DNS_RECORDS` and `dnsRecords` are left in place (never dispatched
today, but historical operation log entries must still replay
deterministically). The UI stops surfacing them; the gitops template
already ignores them.

### Processor / gitops

`processors/vetra-cloud-environment/gitops.ts::generateValuesYaml`:

- If `customDomain.enabled` and `apexService` matches the service's
  type: set that service's `ingress.host` to `customDomain.domain` and
  skip the `additionalIngresses` block for it.
- The helm chart's `powerhouse.serviceHost` helper already preserves an
  explicit `ingress.host` over the generic `<service>.<subdomain>.vetra.io`
  pattern, so apex routing requires no chart changes.
- TLS secret name for the apex cert: `<service>-<domain-with-dashes>-tls`,
  matching the existing `additionalIngresses` pattern.
- external-dns picks up the new host from the existing
  `external-dns.alpha.kubernetes.io/hostname` annotation — no new plumbing.

For non-apex services with a custom domain, the existing
`additionalIngresses` fallback stays available (not exercised by admin
but not actively harmful).

### Domain uniqueness

New mutation in the observability subgraph:

```graphql
type Mutation {
  setCustomDomain(
    documentId: String!,
    enabled: Boolean!,
    domain: String,
    apexService: TenantService
  ): VetraCloudEnvironmentSummary!
}
```

The resolver:

1. `SELECT id FROM environments WHERE customDomain = $domain AND id != $self AND status NOT IN ('TERMINATING','DESTROYED','ARCHIVED')`
2. If a row exists → throw `DOMAIN_TAKEN`.
3. Dispatch `SET_CUSTOM_DOMAIN` and `SET_APEX_SERVICE` on the document.

Reducer stays pure — uniqueness is an API-layer invariant. The gitops
mutex serializes sync, so the worst-case race (two concurrent claims
both passing the check) manifests as a failed second Helm sync, which
is recoverable.

### vetra.to UI

`app/cloud/[project]/tabs/overview.tsx::CustomDomainSection`:

- When the entered domain ends in `.vetra.io` (or its exact apex),
  hide the DNS records table and "Verify DNS" button. Replace with a
  short note: "DNS is managed automatically for `.vetra.io` domains."
- Add an "Serve at apex" control (radio/select) listing the enabled
  services; selecting one sets `apexService`. Hidden when no custom
  domain is set.
- Service rows in the overview: when `apexService` matches, render the
  URL as `customDomain.domain` instead of `<prefix>.<customDomain>`.

`modules/cloud/hooks/use-environment.ts` + `graphql.ts`: call the new
`setCustomDomain` mutation instead of dispatching the action
directly; surface `DOMAIN_TAKEN` as a toast error.

### Admin environments

Three documents created through the UI:

| Label       | `customDomain.domain`       | Services  | `apexService` |
|-------------|-----------------------------|-----------|---------------|
| admin-dev   | admin-dev.vetra.io          | CONNECT   | CONNECT       |
| admin-staging | admin-staging.vetra.io    | CONNECT   | CONNECT       |
| admin       | admin.vetra.io              | CONNECT   | CONNECT       |

Each gets an admin PH package installed (name TBD, out of scope for
this change — the feature exists independently of what ships in the
envs).

## Rollout

1. Document model change + regen + src-reducer update + `ph build` +
   `ph publish --registry registry.dev.vetra.io`.
2. Processor + subgraph changes in the same package version.
3. vetra.to bumps the package dep and picks up the new
   `apexService` field and mutation.
4. Existing environments are unaffected (`apexService = null` is the
   default; behavior matches today).

## Open (deferred)

- Hardcoded `.vetra.io` check vs. configurable owned-zone list: go with
  hardcoded constant (`OWNED_DNS_ZONES = [".vetra.io"]`) in the UI and
  processor for now. Trivial to extend for dtbc.cloud later without
  a schema change.
