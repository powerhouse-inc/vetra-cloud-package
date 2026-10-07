# Apps as document models

**Date:** 2026-10-07
**Status:** design, awaiting review
**Supersedes:** the catalog design in
`2026-10-07-app-artifacts-and-template-builder-design.md`, whose `app_artifacts`
tables are replaced by artifacts held inside the app document. The rest of that
spec — multi-artifact publishing, the template builder, provisioning — still
stands and is unchanged by this document.

## Why

`VetraCloudEnvironment` is a document model and holds
`app: VetraCloudAppLink { appId: String! }` — a document pointing at a **table
row** by bare string. Licences and licence types are documents; the apps they
are issued against are not. That straddle is why licensing feels bolted on: a
template cannot reference an app's artifacts as data, only as free text.

Making apps documents also dissolves a real objection. Artifacts as *separate*
documents declaring which app they belong to would recreate the forged-`appId`
hole closed in `app_license_grants`: a reducer cannot check a table, so nothing
could stop one publisher claiming another's package name. Artifacts held **inside
the app document** have no app id to forge — the list is scoped by the document
itself.

## Non-goal: secrets in documents

The app row holds `harbor_robot_secret_enc` and the GitHub token columns.
Documents sync; secret material must not.

The precedent is the environment model, which carries `isSecret: Boolean` flags
while the values live in OpenBao via the secrets controller. Apps follow it: the
document holds what a publisher owns and reads, and credentials stay in a table.

## The identity decision that makes this safe

**Each app document is created with the same id as its existing table row.**

Six apps are live in production (achra, dtbau-package, pfnur-toll-collect-portal,
knowledge-vault, bai-knowledge-note, and achra's deleted predecessor), and three
things already reference `apps.id`: `VetraCloudAppLink.appId` on every
environment document, `app_deployments.app_id`, and `app_license_grants.app_id`
— the licensing authorisation gate now running in production.

Preserving the id means none of those references change. The migration becomes
additive, and a rollback is "read from the table again" rather than a data
repair.

## The document model

New model `powerhouse/vetra-app`, versioned v1 alongside the existing three.

```graphql
type VetraAppState {
  name: String
  slug: String
  owner: EthereumAddress
  status: VetraAppStatus!
  repository: VetraAppRepository
  identity: VetraAppIdentity
  productionEnvironmentId: OID
  previews: VetraAppPreviews
  artifacts: [VetraAppArtifact!]!
}

enum VetraAppStatus { PENDING_IDENTITY  ACTIVE  DISCONNECTED  DELETED }

type VetraAppRepository {
  repositoryId: String
  fullName: String
  productionBranch: String
}

type VetraAppIdentity {
  did: String
  expiresAt: DateTime
}

type VetraAppPreviews {
  enabled: Boolean!
  limit: Int!
  ttlDays: Int!
}

"""What the app has actually published. A row exists only once it is installable."""
type VetraAppArtifact {
  id: OID!
  kind: VetraAppArtifactKind!
  name: String!
  versions: [VetraAppArtifactVersion!]!
  channels: [VetraAppArtifactChannel!]!
}

enum VetraAppArtifactKind { PACKAGE  FUSION_IMAGE }

type VetraAppArtifactVersion {
  version: String!
  """Registry specifier or full image reference."""
  reference: String!
  """Null means discovered by the reconciler rather than registered by a run."""
  commitSha: String
  runId: String
  publishedAt: DateTime!
}

"""Channel -> version pointer, the dist-tag model."""
type VetraAppArtifactChannel {
  channel: AutoUpdateChannel!
  version: String!
}
```

`AutoUpdateChannel { DEV, STAGING, LATEST }` already exists in
`vetra-cloud-environment` and is reused verbatim rather than duplicated. The
earlier spec invented a parallel free-string channel; that was a mistake and is
dropped.

### Operations

Mirroring the existing table writes, one reducer each:
`SET_APP_DETAILS`, `CONNECT_REPOSITORY`, `SET_IDENTITY`, `SET_STATUS`,
`SET_PREVIEWS`, `SET_PRODUCTION_ENVIRONMENT`, `RECORD_ARTIFACT_VERSION`,
`SET_ARTIFACT_CHANNEL`.

`RECORD_ARTIFACT_VERSION` is idempotent on `(kind, name, version)` — a re-run of
the same CI job overwrites rather than appending. `SET_ARTIFACT_CHANNEL` points a
channel at a version that must already exist in `versions`, so a channel can
never reference something uninstallable; a republish of an older build moves the
pointer backwards, because `LATEST` is a publisher decision and not a sort order.

## What stays in tables

`app_credentials`, keyed by the app document id:

```
app_credentials
  app_id                  the document id
  installation_id         GitHub App installation
  harbor_project
  harbor_robot_name
  harbor_robot_id
  harbor_robot_secret_enc AES-256-GCM, VETRA_APPS_ENCRYPTION_KEY
  created_at, updated_at
```

`app_deployments`, `app_previews` and `github_deploy_connections` stay as they
are: high-volume operational records and per-owner GitHub tokens, neither of
which a publisher reads as part of their app.

## Migration — dual-write, in three deployable steps

Licensing is live in production and authorises against `apps.owner_address` on
every publisher mutation. The sequence never has a moment where ownership cannot
be resolved.

**Step 1 — backfill and dual-write.** Create one app document per existing row,
with the row's id, and copy its fields. Every write that touches an app writes
both the table and the document. Reads still come from the table, so behaviour is
unchanged and the document is provably correct before anything depends on it. A
reconciler compares the two and logs drift.

**Step 2 — reads move to the document.** `getApp` and `getAppByIdentity` in
`subgraphs/vetra-apps/repo.ts` are the two accessors the subgraph funnels through;
they switch to reading the document, as does licensing's `findAppById` /
`findAppByIdentityDid` wiring in `subgraphs/vetra-licensing/index.ts:139`.
Writes stay dual. Rollback is one line in each accessor.

**Step 3 — drop the duplicated columns.** Once reads have run on documents
through a staging soak and a production soak, the table keeps only what
`app_credentials` needs.

Artifacts are written to the document from the start: they are new, so they have
no table to dual-write against.

## Error handling

- **Document missing for a live row** (backfill gap): the accessor falls back to
  the table and logs, rather than reporting the app does not exist. An app that
  cannot be resolved must never read as unowned, because `resolveOwnerApp`
  refusing is indistinguishable from "not your app".
- **Drift between table and document** during dual-write: the table wins while
  reads are on the table (Step 1), the document wins afterwards (Step 2). The
  reconciler logs every difference; it never silently repairs, so a write bug is
  visible rather than absorbed.
- **A channel pointing at a missing version**: refused by the reducer.
- **Artifact registration failing after a successful publish**: the artifact
  exists but is uncatalogued; the reconciler picks it up. Publishing is never
  rolled back for a catalog write.

## Testing

- Reducers: idempotent `RECORD_ARTIFACT_VERSION`; `SET_ARTIFACT_CHANNEL` refusing
  an unknown version; a channel moving backwards on republish. Reducer rejections
  do not throw, so every test asserts on the appended operation's `error` field.
- Backfill: a document is created per row with the **same id**, and running it
  twice does not duplicate or clobber.
- Dual-write: a change through the service appears in both stores; the
  reconciler reports drift rather than hiding it.
- Accessor switch: `getApp` returns the same shape from the document as from the
  table — the same assertions run against both, which is what makes the switch
  safe.
- Licensing unaffected: `resolveOwnerApp` still refuses another publisher's app
  when ownership is read from the document. The existing isolation suite runs
  unchanged against the new read path.

## Risks

- **Six live apps and a live licensing gate.** Mitigated by preserving ids, by
  reads only moving after the document is proven, and by each step being
  independently revertible.
- **Secrets split across two stores.** An app's credentials no longer live beside
  its facts, so deleting an app must delete both. The existing soft-delete keeps
  the row forever, which makes an orphaned credential row the failure mode rather
  than a dangling reference.
- **Document size.** An app that publishes often accumulates versions in one
  document. Versions are capped per artifact in the reducer, oldest dropped,
  because a document that grows without bound eventually fails to load — and a
  dropdown never needs the whole history.
