# App artifacts and the template builder

**Date:** 2026-10-07
**Status:** design, awaiting review
**Repo:** `vetra-cloud-package` — `subgraphs/vetra-apps`, `subgraphs/vetra-licensing`,
`document-models/app-license-type`; UI in `vetra.io`.

## Intent

A publisher's repository produces several things at once. `web3-berlin/dtbau-package`
is the worked example: one **package** (`document-models/`, `editors/`, built with
`ph-cli generate`), and two **fusion apps** — `apps/dtbau-psb` and
`apps/dtbau-backup`, each a Next.js app with its own `Dockerfile`.

Today Vetra can express none of that. `vetra-deploy-action` takes a single
`fusion-dockerfile`, so a repo ships one image or none. Publishing authenticates
with a registry token that is not tied to the app, which is why a fork publishing
`@powerhousedao/knowledge-note` is refused with *"not authorized to publish
(owned by another user)"*. And a licence template describes services as
`{type, prefix}` — `FUSION` with no way to say **which** fusion app — so the
publisher types package names and service strings as free text and learns at
provision time whether they were right.

The goal is that a publisher composes a tier by **selecting from what their app
actually published**, and that a licence then delivers exactly that. Licensing
stops being a detached form and becomes the last step of the same flow.

### What success looks like

- One deploy run of `dtbau-package` publishes the package **and** both fusion
  images, under the app's own identity.
- A publisher creating a tier picks `dtbau-package`, `dtbau-psb` and
  `dtbau-backup` from dropdowns. No free-text artifact names anywhere.
- A holder's environment runs a switchboard plus both dtbau apps at distinct
  prefixes, because the template said so.

### Decisions already taken

Settled in conversation before this document; recorded so later readers do not
relitigate them.

1. **Template services reference an artifact.** A service entry becomes
   `{type, artifactRef, prefix}`. A template may carry several `FUSION` entries,
   so one environment can run `dtbau-psb` and `dtbau-backup` at different
   prefixes. Rejected: one fusion app per template (cannot express both), and
   templates that reference only the app (publisher loses control of tiering).
2. **Artifacts track a channel and auto-update.** A template references
   `dtbau-psb@latest` rather than a pinned version; publishing a new version
   moves every holder on that channel. The cost is accepted knowingly: a bad
   release reaches all holders at once. See *Risks*.
3. **Catalog is a table Vetra owns, written at publish time**, with a reconciler
   that backfills from Harbor and the registry. Rejected: deriving live from
   Harbor/registry on every keystroke (no provenance, slow, cannot distinguish a
   half-published artifact), and declaring artifacts in the repo (describes
   intent, not what exists, so the dropdown can offer an uninstallable version).

## Architecture

Four units, each independently testable, in dependency order.

```
  deploy action ──registers──▶ app_artifacts ──reads──▶ template builder (UI)
                                     │                        │
                                     │                     licence type
                                     ▼                        │
                              channel pointers ◀──resolves── keeper ──▶ environment
```

### Phase 1 — the artifact catalog (`subgraphs/vetra-apps`)

Two tables, modelled on npm's version/dist-tag split because templates reference
a channel while environments need a concrete version.

```
app_artifacts
  app_id        references apps.id
  kind          'PACKAGE' | 'FUSION_IMAGE'
  name          '@powerhousedao/dtbau-package' | 'dtbau-psb'
  version       '1.0.0'
  reference     what a consumer installs or pulls:
                a registry specifier, or cr.vetra.io/<harbor_project>/<name>:<tag>
  commit_sha    the commit that produced it
  run_id        the CI run that produced it
  created_at
  PRIMARY KEY (app_id, kind, name, version)

app_artifact_channels
  app_id, kind, name, channel        e.g. 'latest', 'dev', 'main'
  version                            the version this channel currently points at
  updated_at
  PRIMARY KEY (app_id, kind, name, channel)
```

A row exists only once the artifact is **actually published**, so the dropdown
cannot offer something uninstallable. Registration is idempotent on the primary
key: a re-run of the same CI job overwrites rather than duplicating.

**Reconciler.** Apps that published before this existed — achra, and dtbau's
hand-rolled `publish-images.yml` — would otherwise be invisible. A periodic
sweep lists each app's Harbor project and its registry scope and inserts rows it
finds, marking them `commit_sha = null` to distinguish discovered artifacts from
registered ones.

**Ownership is the authorisation boundary.** `app_artifacts.app_id` is what
answers "may this app publish under this name", which is the question the
knowledge-note 403 was really asking.

### Phase 2 — multi-artifact publishing (`vetra-deploy-action`)

The action gains a repo-level description of what to produce, replacing the
single `fusion-dockerfile`:

```yaml
- uses: powerhouse-inc/vetra-deploy-action@v1
  with:
    app-id: <uuid>
    package: .                      # ph build && ph publish; '' to skip
    fusion-apps: |                  # one entry per image
      dtbau-psb:    apps/dtbau-psb/Dockerfile
      dtbau-backup: apps/dtbau-backup/Dockerfile
```

`fusion-dockerfile`/`fusion-image-name` keep working as a one-entry shorthand, so
achra and knowledge-note do not break.

**Publishing authenticates as the app's Renown workload identity**, not a shared
registry token. Every app already has its own identity — `apps.identity_did`,
minted at registration via the platform's `RENOWN_WORKLOAD_REGISTRATION_TOKEN`,
which is the credential that *creates* identities and is not itself the app's.
The mechanism to use it in CI also exists: the action already exchanges a GitHub
OIDC token for a bearer (`renown-url`), which proves the run belongs to that
repository. Publishing uses that bearer, and the registry authorises by the
app's ownership of the package name.

This is the difference between per-app publishing and a shared credential that
happens to have rights, and it is what the knowledge-note 403 was really about:
the publish was refused because the credential was not tied to an app that owns
`@powerhousedao/knowledge-note`.

Each successful publish or image push calls the CI API to register its artifact
and move its channel pointer.

### Phase 3 — the template builder

**Model** (`document-models/app-license-type`). `TemplateService` gains an
optional artifact reference:

```graphql
type TemplateService {
  id: OID!
  type: TemplateServiceType!
  prefix: String
  artifactName: String      # 'dtbau-psb'; null for CONNECT/SWITCHBOARD
  artifactChannel: String    # 'latest'
}
```

`TemplatePackage` already has `packageName`/`version`; `version` carries a
channel under the same rule.

**Resolved-version hashing.** The keeper decides whether to re-provision by
diffing `templateHash`. A template that stores `dtbau-psb@latest` does not change
when 1.3.0 publishes, so a literal hash would never re-provision anyone and
decision 2 would silently not work. `templateHash` is therefore computed over
the **resolved** artifact versions, read from `app_artifact_channels` at plan
time, not over the template's text. The resolved set is recorded on the
environment row so a later tick can tell what the holder is actually running.

**UI** (`vetra.io`, `modules/publisher`). Every artifact field becomes a select
backed by the catalog, replacing free text:

- *Packages*: pick from this app's `PACKAGE` artifacts; channel defaults to `latest`.
- *Services*: pick a type; when the type is `FUSION`, a second select lists this
  app's `FUSION_IMAGE` artifacts. Prefix defaults to the artifact name.
- A tier summary reads as a sentence — "Switchboard at `api`, dtbau-psb at
  `psb`, dtbau-backup at `backup`, with dtbau-package installed" — so the
  publisher can check the tier without reading a form back to themselves.

An app with no catalogued artifacts shows why ("this app has not published
anything yet") rather than an empty dropdown, which is the failure mode that
makes a form feel broken.

### Phase 4 — provisioning

The keeper resolves each template service's artifact to a concrete version,
renders the environment with one FUSION service per artifact entry, and keys the
environment's recorded hash on the resolved set. This is also where
**shared vs dedicated** delivery from
`2026-10-07-licensing-product-model.md` lands, because both changes rewrite the
same plan-and-release path and splitting them would mean rewriting it twice.

## Error handling

- **Artifact referenced by a template disappears** (yanked version, deleted
  image): the keeper treats the licence as unresolvable and **holds** the
  environment — the existing precedent for an unresolvable licence type, and it
  keeps the failure non-destructive.
- **Channel points at nothing**: the tier is refused at publish time, not at
  provision time, so the publisher learns immediately.
- **Registration fails after a successful publish**: the artifact exists but is
  uncatalogued; the reconciler picks it up. Publishing is never rolled back for
  a catalog write.
- **Partial multi-image build**: images already pushed stay registered; the run
  fails and reports which app failed. A later run re-registers idempotently.

## Testing

- Catalog: registration idempotency, channel pointer movement, reconciler
  inserting discovered artifacts without clobbering registered ones.
- Publishing: argument construction for several fusion apps, including the
  one-entry shorthand; that a failed image does not abort already-pushed ones.
- Hashing: the property the design turns on — publishing a new version under a
  tracked channel **changes** the resolved hash, and republishing the same
  version does not. Mutation-tested, since a hash that never changes would make
  auto-update silently dead.
- UI: a select offers exactly the app's catalogued artifacts (pinned to the
  catalog the way the service picker is pinned to the model enum today); the
  empty-catalog state explains itself.
- Keeper: a template with two FUSION entries yields two services at distinct
  prefixes; a vanished artifact holds rather than releases.

## Risks

- **Auto-update blast radius.** Decision 2 means a bad release re-provisions
  every holder on that channel, with no staging. Accepted deliberately. If this
  bites, the smallest mitigation is per-tier channel choice (the rejected
  "pin by default, channel opt-in" option), which this model already allows
  because the channel lives on the service entry.
- **Re-provisioning cost.** Auto-update makes re-provisioning routine rather
  than exceptional. The keeper's apply path must be safe to run often, and the
  existing per-app environment cap applies.
- **Reconciler ambiguity.** Harbor images are namespaced per app via
  `harbor_project`, but registry packages are not inherently app-scoped. The
  reconciler can only attribute a package to an app where ownership is already
  recorded; anything else stays uncatalogued rather than being guessed.

## Out of scope

- Billing or payment for tiers.
- Landing pages, which are promotional and never part of a template.
- Drive apps and drive editors: `apps/*` here are fusion apps, and the drive
  explorer is not involved.
