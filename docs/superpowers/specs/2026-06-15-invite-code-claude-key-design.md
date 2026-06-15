# Claude API key attached to invite codes

Attach an Anthropic (Claude) API key to an invite code so that, when a user
redeems the code and provisions a Vetra Studio, the key is supplied
automatically instead of being typed in. The key is delivered **server-side,
inside the `vetra-cloud-package` reactor** — it is never sent to the browser.

This feature spans two repos:

- **`vetra-cloud-package`** (this repo) — the `vetra-access-codes` subgraph
  owns the attached key and performs the injection. This is the bulk of the work.
- **`vetra.to`** — the studio creation flow drops the manual key prompt when a
  key is available and calls the injection mutation instead.

It builds directly on the access-codes subgraph described in
`vetra.to/docs/vetra-access-codes-subgraph.md`.

---

## 1. Core principle

The attached key lives in the reactor and is written to the tenant secret store
entirely server-side. The browser receives only a **boolean** indicating whether
a key is available for the caller — never the key itself.

This is the reason the delivery model is server-side injection rather than
returning the key to the authenticated redeemer: a multi-use cohort code
(`local-first`, `cohort-1`) carries one shared org key, and returning it would
place that shared secret in every redeemer's browser, network logs, and client
state. Keeping it in the reactor confines it to where the tenant secrets already
live (OpenBao + the encrypted `tenant_secrets` table).

---

## 2. Storage — `vetra-access-codes` subgraph

Add one nullable column to `invite_codes`:

- **`anthropic_key_ciphertext: text`** — the Anthropic key **encrypted at rest**
  via OpenBao transit, or `null` when the code has no attached key.

Encryption at rest uses the existing `OpenBaoTransitClient` with a fixed
pseudo-tenant string (constant, e.g. `ACCESS_CODES_TRANSIT_TENANT = "access-codes"`),
so the attached key gets its own transit key (`vetra-tenant-access-codes`) and is
never stored as plaintext. `OpenBaoTransitClient` already exposes
`encrypt(tenant, plaintext)` / `decrypt(tenant, ciphertext)` / `ensureTenantKey`,
keyed by an arbitrary tenant string — no transit changes needed.

Migration (idempotent, boot-time runner — matches the existing `.ifNotExists()`
style in `db/migrations.ts`):

```sql
ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS anthropic_key_ciphertext text
```

Run as raw SQL via Kysely's `sql` template so it is safe to re-run on every boot
(Kysely's `addColumn` builder has no `ifNotExists`).

`onSetup` gains an `OpenBaoTransitClient` (same `OPENBAO_ADDR` env the secrets
subgraph already requires) plus a handle to the `vetra-cloud-secrets` namespace
(see §4). This adds a dependency on `OPENBAO_ADDR` to the access-codes subgraph —
an accepted coupling within the package.

---

## 3. GraphQL surface + resolvers — `vetra-access-codes`

### Admin (gated by the existing `requireAdmin`)

- `createInviteCode(code, label, expiresAt, maxUses, anthropicApiKey: String)` —
  new optional `anthropicApiKey`. When provided, encrypt and store.
- `setInviteCodeAnthropicKey(code: String!, anthropicApiKey: String): InviteCode!` —
  set or rotate the key on an existing code; `null` clears it. Lets admins
  manage keys without recreating codes.
- `InviteCode` type gains **`hasAnthropicKey: Boolean!`**. Admin listings expose
  only this boolean — the raw key value is never returned by any query.

### Caller-scoped — the injection

```graphql
applyInviteCodeSecret(tenantId: String!, secretNames: [String!]!): ApplyInviteCodeSecretResult!

type ApplyInviteCodeSecretResult {
  injected: Boolean!
  secretNames: [String!]!
}
```

- DID derived from the verified token (`UNAUTHENTICATED` if absent).
- Finds the caller's **most-recent active (non-expired) redemption whose code
  carries a key**. None found → `{ injected: false, secretNames: [] }`.
- Decrypts the code's key, then calls the existing
  `createSecretsService().setSecret(tenantId, name, value)` **in-process** for
  each requested name. `setSecret` encrypts per-tenant and `pg_notify`s the
  reconciler — identical to the manual config path today, so studio boot is
  unchanged.
- Generic by design: the studio-specific secret names are passed by the caller,
  not hardcoded in the subgraph. `setSecret` already validates each key against
  `^[A-Z][A-Z0-9_]*$`.

### Status boolean

`AccessStatus` gains **`hasAttachedKey: Boolean!`**, returned by `myAccessStatus`
and `redeemInviteCode`, so the UI knows whether to prompt for a key — boolean
only, never the key.

### Auth posture

`applyInviteCodeSecret` requires an authenticated caller who holds a key-bearing
redemption — strictly tighter than the existing `setSecret` on the secrets
subgraph, which accepts a `tenantId` with no ownership check. This design matches
that existing posture: no additional tenant-owner check. The residual risk is a
user writing their own cohort key into a `tenantId` they do not own; since the
key is shared across the cohort anyway, this grants nothing the caller could not
already do, and is documented rather than guarded.

### `db/codes.ts` changes

- `createCode` / `setActiveCode`: unchanged signatures except `createCode`
  accepts an optional pre-encrypted ciphertext.
- New `setCodeAnthropicKey(db, code, ciphertext | null)`.
- New `getRedeemedKeyCiphertext(db, did): Promise<string | null>` — most-recent
  active redemption joined to `invite_codes` where `anthropic_key_ciphertext is
  not null`.
- `codeView` / `listCodes`: add `hasAnthropicKey = anthropic_key_ciphertext != null`.
  The ciphertext itself is never selected into a view returned to GraphQL.

Encryption/decryption (OpenBao calls) live in the resolver/subgraph layer, not in
`codes.ts`, keeping `codes.ts` pure Kysely and unit-testable without OpenBao.

---

## 4. In-process secrets-service reuse

The injection writes through the **same** `createSecretsService` the
`vetra-cloud-secrets` subgraph uses. The service comment already documents
in-process reuse (the `vetra-cloud-environment` gitops processor consumes it the
same way), so this is an established pattern.

`vetra-access-codes` `onSetup`:

1. Opens its own namespace (`vetra-access-codes`) as today.
2. Additionally opens the `vetra-cloud-secrets` namespace
   (`this.relationalDb.createNamespace("vetra-cloud-secrets")`) — `createNamespace`
   returns a Kysely bound to the same tables the secrets subgraph migrates.
3. Constructs one `OpenBaoTransitClient` (used both for at-rest encryption of the
   attached key under the `access-codes` pseudo-tenant, and — via the
   secrets-service — for per-tenant secret encryption on injection).
4. Builds `createSecretsService({ db: secretsNamespaceDb, transit })` and passes
   it into the resolvers.

Ordering note: the secrets subgraph runs `up()` on its namespace at its own boot.
The access-codes subgraph only **reads/writes** those tables (never migrates
them), so as long as both subgraphs are registered in the same reactor the tables
exist. Verify boot ordering during implementation; if the secrets namespace is
not guaranteed present, the access-codes `setSecret` write will surface a clear
error rather than silently failing.

---

## 5. vetra.to — client + studio flow

### `modules/invites/lib/client.ts`

- Extend `AccessStatus` with `hasAttachedKey: boolean`.
- Add `applyInviteCodeSecret(tenantId, secretNames, token)` calling the new
  mutation with the Renown bearer token.

### `modules/cloud/studio/use-create-studio-environment.ts`

`create({ anthropicApiKey? })`. After provisioning and deriving `tenantId`:

- **Manual key passed** (fallback) → `applyConfigChanges` with `setSecret`
  changes, exactly as today.
- **No key passed** → call `applyInviteCodeSecret(tenantId,
  STUDIO_ANTHROPIC_SECRET_NAMES)`. If `injected: false`, throw a typed
  "needs manual key" error the UI can catch.

Then `approveChanges` + `push` (unchanged).

### `modules/cloud/studio` UI

`StudioProductsGrid` / `NewProductCard` branch on `hasAttachedKey`:

- **Has key** → "Create new product" provisions directly, no form (server injects).
- **No key** → show the existing `StudioCreateForm` for manual entry.

`hasAttachedKey` comes from the access status the gate/products flow already
fetches, so no speculative failed create is needed.

---

## 6. Fallback and scope

- **Fallback preserved**: codes without an attached key, and local-run installs,
  keep the manual-entry path untouched.
- **Selection rule, consistent everywhere**: "any active redemption whose code
  has a key, most-recent first" drives both `hasAttachedKey` and what
  `applyInviteCodeSecret` injects. An expired access window means no injection.
- **Out of scope (YAGNI)**: per-user (rather than per-code) keys, usage metering,
  and validating the key against Anthropic before storing it.

---

## 7. Testing

Subgraph (`vetra-cloud-package`):

- `codes.ts`: store/retrieve `hasAnthropicKey`; `getRedeemedKeyCiphertext`
  selection (active vs expired; keyed vs keyless; most-recent-keyed wins).
- resolvers: admin gating on `createInviteCode` / `setInviteCodeAnthropicKey`;
  `applyInviteCodeSecret` returns `injected:true` and writes the secret when a
  keyed redemption exists, `injected:false` when not, and `UNAUTHENTICATED`
  without a token. OpenBao transit and the secrets-service are stubbed.

vetra.to:

- `use-create-studio-environment`: manual-key branch vs injected branch
  (asserts `applyInviteCodeSecret` is called with the studio secret names, and
  the manual `applyConfigChanges` path is taken only when a key is passed).
- grid: form-vs-direct selection based on `hasAttachedKey`.

---

## 8. Future direction: pre-provisioned environments (warm pool)

Not planned here, but recorded because it shapes one decision above.

To cut studio startup time, a pool of environments could be provisioned ahead of
demand and handed to users on claim. The key point for this spec:
**`applyInviteCodeSecret` is intentionally decoupled from environment creation** —
it writes the caller's code key into *whatever* `tenantId` it is given. A warm
pool changes only who creates the env and when; it does not change how the key
arrives. On claim, the flow assigns a pre-provisioned tenant to the user and calls
the **same** injection mutation against that existing `tenantId`.

Implication to preserve during implementation: do not couple key injection to the
client-side `controller.push()` create step. Keep injection as a standalone
mutation keyed by `tenantId` so the warm-pool claim path can reuse it unchanged.
