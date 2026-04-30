# CLINT Announce — Stateless Signed Tokens (Design)

**Status:** Draft
**Date:** 2026-04-30
**Owner:** Frank (vetra-cloud-package)
**Cross-repo dependency:** `powerhouse-k8s-hosting` (chart adds `CLINT_ANNOUNCE_SECRET` to switchboard env via existing `external-secret-gitops` pattern); OpenBao (new shared secret at `powerhouse/shared/clint-announce`).
**Supersedes / extends:** [`2026-04-30-clint-announce-env-contract-design.md`](../../../../powerhouse-k8s-hosting/docs/superpowers/specs/2026-04-30-clint-announce-env-contract-design.md) — that spec fixed the env-var contract; this one fixes the auth model.

## 1. Summary

The `announceClintEndpoints` resolver currently authenticates by looking up `clint_announce_tokens` in `envDb` (via `relationalDb.createNamespace("vetra-cloud-environments")`). The processor mints tokens into a table at the same logical namespace name. **Powerhouse's `createNamespace(name)` doesn't actually share state across components** — the processor's namespace resolves to one Postgres schema (e.g. `ohyfaqbhss`), and the subgraph's call resolves to a different schema (e.g. `jziufckkaz`). The token gets minted in the processor's schema; the resolver looks for it in the subgraph's schema; lookup fails; agent gets a 401.

This spec replaces the stateful lookup with **stateless HMAC-SHA256-signed tokens**. The processor signs `${documentId}|${prefix}` using a shared secret (sourced from OpenBao); the resolver verifies by re-signing and comparing in constant time. No shared table, no cross-component schema coupling.

## 2. Goals

- CLINT agents successfully announce to `announceClintEndpoints` (no 401s for legitimately-issued tokens).
- Eliminate the cross-component shared-table coupling. Processor and observability subgraph no longer reach into each other's persistent state for this concern.
- Use the same OpenBao + `external-secret-gitops` pattern as `CLOUD_AUTO_UPDATE_SECRET` — no new infrastructure.

## 3. Non-goals (deferred)

- Token expiration / TTL. Signed tokens are scoped by `(documentId, prefix)` and bound to the env's lifetime; rotating the env doc id (or the shared secret) revokes them. No `exp` claim in the token payload.
- Per-environment / per-agent secrets. One global secret for all CLINT services in the cluster, mirroring `CLOUD_AUTO_UPDATE_SECRET`.
- Backwards-compat for old random tokens still in flight on existing CLINT pods. A dual-mode "verify signature OR fall back to DB lookup" is rejected — adds back exactly the coupling we're removing. Cutover plan: roll all CLINT pods so they pick up a freshly-signed token from the new processor (~30s downtime per agent, acceptable in dev).
- A general-purpose framework helper for stateless token auth in subgraphs. Build the specific helper this design needs; generalize later if a second use case appears.

## 4. Architectural decision: HMAC over a shared OpenBao secret

### 4.1 Token shape

```
token = base64url( HMAC-SHA256( secret, `${documentId}|${prefix}` ) )
```

- `secret`: 32-byte random value generated once and stored in OpenBao at `powerhouse/shared/clint-announce` with property `secret` (base64). Rotated by overwriting that path; rotation invalidates all tokens in flight, agents pick up new ones on next pod cycle.
- `documentId`: env doc id (UUID). Stable for the env's lifetime.
- `prefix`: CLINT service prefix (e.g. `ph-pirate-wouter`). Stable for the service's lifetime; renaming a service is the same as creating a new one (gitops emits a new agent name, ingress, etc.).
- The `|` separator is unambiguous because both fields are typed (UUID, lowercased kebab) and never contain `|` themselves.
- Output is base64url to match the existing token shape stored in pod env vars (~43 chars; same length the previous random-bytes token produced, so log lines look unchanged).

### 4.2 Secret distribution

Reuse the `external-secret-gitops` template in `powerhouse-chart`. Add a third `secretKey` block alongside `GITOPS_*` and `CLOUD_AUTO_UPDATE_SECRET`:

```yaml
- secretKey: CLINT_ANNOUNCE_SECRET
  remoteRef:
    key: {{ .Values.switchboard.clintAnnounce.secretPath | default "powerhouse/shared/clint-announce" }}
    property: secret
```

Gated on `.Values.switchboard.clintAnnounce.enabled` (default `false` for backwards-compat with tenants that haven't bumped values). Staging's tenant values flip it to `true` alongside `CLOUD_AUTO_UPDATE_SECRET`.

The materialized Secret already feeds switchboard's `envSecret:` block — staging's tenant values append `CLINT_ANNOUNCE_SECRET: CLINT_ANNOUNCE_SECRET` to that map, surfacing it as `process.env.CLINT_ANNOUNCE_SECRET` on the staging switchboard pod. **Only staging needs it** today (the staging switchboard runs the processor for every env doc in the cluster — see §4.4).

### 4.3 Sign / verify helpers

New shared module: `vetra-cloud-package/shared/clint-announce-token.ts`. Two pure functions, both synchronous, both used by processor and subgraph:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignInput = { documentId: string; prefix: string };

export function signClintAnnounceToken(input: SignInput, secret: Buffer): string {
  const payload = `${input.documentId}|${input.prefix}`;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifyClintAnnounceToken(
  presented: string,
  input: SignInput,
  secret: Buffer,
): boolean {
  const expected = signClintAnnounceToken(input, secret);
  // Both base64url-encoded, identical length when valid → safe to constant-time compare.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
```

Caller resolves the secret once at startup from `process.env.CLINT_ANNOUNCE_SECRET` (decoded via `Buffer.from(env, 'base64')`) and passes the `Buffer` in. The helpers don't read env vars themselves — easier to test.

### 4.4 Single mint authority

The staging switchboard hosts every env doc and runs the only instance of the vetra-cloud-environment processor that handles CLINT services in this cluster. There is no per-tenant processor minting tokens. Only `staging-switchboard` needs `CLINT_ANNOUNCE_SECRET` to sign; only staging-switchboard's observability subgraph needs it to verify. Same pod runs both.

Tenant switchboards (e.g. `sure-fawn-71-60eb44ad`'s) host the agent pods themselves but don't run the cloud-environment processor — they don't need the secret.

This design makes `CLINT_ANNOUNCE_SECRET` a **staging-only** chart concern. The `external-secret-gitops` block already gates on `gitops.enabled`, which only staging has.

## 5. Code changes

### 5.1 `shared/clint-announce-token.ts` (new file)

The two helpers from §4.3. Plus a third helper for callers that want to read+decode the secret from env in one call:

```ts
export function loadClintAnnounceSecret(): Buffer {
  const raw = process.env.CLINT_ANNOUNCE_SECRET;
  if (!raw) {
    throw new Error('CLINT_ANNOUNCE_SECRET env var is required for CLINT announce token signing/verification');
  }
  return Buffer.from(raw, 'base64');
}
```

Throws on missing secret to fail-fast at boot; the alternative (returning `null` and silently disabling announce) hides misconfigurations.

### 5.2 `processors/vetra-cloud-environment/gitops.ts`

Replace `ensureClintAnnounceTokens` (DB-backed) with a sync `mintClintAnnounceTokens` that calls `signClintAnnounceToken` per CLINT service:

```ts
import { loadClintAnnounceSecret, signClintAnnounceToken } from '../../shared/clint-announce-token.js';

function mintClintAnnounceTokens(
  state: VetraCloudEnvironmentState,
  documentId: string,
): Record<string, string> {
  const secret = loadClintAnnounceSecret();
  const clintServices = (state.services ?? []).filter(
    (s) => s.type === 'CLINT' && s.enabled,
  );
  const tokens: Record<string, string> = {};
  for (const svc of clintServices) {
    tokens[svc.prefix] = signClintAnnounceToken({ documentId, prefix: svc.prefix }, secret);
  }
  return tokens;
}
```

The caller in `generateValuesYaml` (around the existing `await ensureClintAnnounceTokens(db, state, documentId)` line) becomes synchronous and drops the `db` argument:

```ts
const announceTokens = mintClintAnnounceTokens(state, documentId);
```

The `db: Kysely<DB>` parameter on `generateValuesYaml` itself is still needed for other reasons (cnpg backup state, etc.), so its signature doesn't change.

### 5.3 `subgraphs/vetra-cloud-observability/resolvers.ts`

Replace the `envDb.selectFrom("clint_announce_tokens")` block in `announceClintEndpoints` with a signature check:

```ts
import { loadClintAnnounceSecret, verifyClintAnnounceToken } from '../../shared/clint-announce-token.js';

// At resolver factory startup (alongside `const envDb = config.envDb;`):
const announceSecret = loadClintAnnounceSecret();

// Inside announceClintEndpoints, replacing the lookup:
const presented = (authHeader ?? '').startsWith('Bearer ')
  ? (authHeader as string).slice('Bearer '.length).trim()
  : '';
if (!presented) throw new Error('UNAUTHORIZED');

if (!verifyClintAnnounceToken(presented, { documentId, prefix }, announceSecret)) {
  throw new Error('UNAUTHORIZED');
}
```

The rest of the resolver (the `clint_runtime_endpoints` upsert) is unchanged.

### 5.4 `processors/vetra-cloud-environment/migrations.ts`

Add a new migration that drops `clint_announce_tokens`:

```ts
// migration N+1: drop clint_announce_tokens — replaced by HMAC-signed
// stateless tokens. Safe one-way drop because the new processor
// re-emits signed tokens on every reconcile.
{
  name: 'drop_clint_announce_tokens',
  up: async (db: Kysely<DB>) => {
    await db.schema.dropTable('clint_announce_tokens').ifExists().execute();
  },
}
```

The existing `up` migration (creating the table) stays; ordering ensures clean install→drop on fresh deployments.

### 5.5 `powerhouse-k8s-hosting/powerhouse-chart/templates/external-secret-gitops.yaml`

Append a new `secretKey` block before the closing `{{- end }}` of the `data:` list:

```yaml
{{- if and .Values.switchboard.clintAnnounce (eq (.Values.switchboard.clintAnnounce.enabled | toString) "true") }}
- secretKey: CLINT_ANNOUNCE_SECRET
  remoteRef:
    key: {{ .Values.switchboard.clintAnnounce.secretPath | default "powerhouse/shared/clint-announce" }}
    property: secret
{{- end }}
```

Add to `powerhouse-chart/values.yaml` under the `switchboard:` block:

```yaml
clintAnnounce:
  enabled: false
  secretPath: powerhouse/shared/clint-announce
```

Default off; tenants opt in.

### 5.6 `powerhouse-k8s-hosting/tenants/staging/powerhouse-values.yaml`

Two edits inside the `switchboard:` block:

1. Enable the flag:

```yaml
clintAnnounce:
  enabled: true
```

2. Add to `envSecret:` (around line 109 today):

```yaml
envSecret:
  GITOPS_REPO_URL: GITOPS_REPO_URL
  GITOPS_GITHUB_PAT: GITOPS_GITHUB_PAT
  CLOUD_AUTO_UPDATE_SECRET: CLOUD_AUTO_UPDATE_SECRET
  CLINT_ANNOUNCE_SECRET: CLINT_ANNOUNCE_SECRET   # NEW
```

This surfaces `CLINT_ANNOUNCE_SECRET` as `process.env.CLINT_ANNOUNCE_SECRET` inside the staging switchboard pod, where both the processor and the observability subgraph run.

## 6. OpenBao secret

Before the chart change deploys, write the shared secret once:

```
bao kv put powerhouse/shared/clint-announce secret="$(openssl rand -base64 32)"
```

(The `bao` CLI is the OpenBao client per the user's existing OpenBao setup notes.) Verify:

```
bao kv get -field=secret powerhouse/shared/clint-announce
```

If the secret is missing when ESO refreshes, the ExternalSecret enters an error state and the switchboard pod fails to receive its env (existing pattern with `CLOUD_AUTO_UPDATE_SECRET`).

## 7. Cutover sequence

Order matters because the processor and resolver are versioned together (same package), but agents in flight have OLD random tokens that the NEW resolver won't accept:

1. Write the secret to OpenBao (no-op until something reads it).
2. Apply chart change to k8s-hosting `main` (extra `secretKey`, values default + staging flip, envSecret addition).
3. Wait for ESO to materialize `CLINT_ANNOUNCE_SECRET` into the staging switchboard's env Secret (~1-2 min).
4. Bump `vetra-cloud-package` (publish new dev version with code changes from §5.1-5.4).
5. Bump staging's `PH_REGISTRY_PACKAGES` to the new version.
6. Staging switchboard restarts with the new code AND the new env var.
7. Processor reconciles every env doc; emits new tenant YAMLs with freshly-signed tokens.
8. ArgoCD applies tenant YAMLs; CLINT pods cycle one at a time (`Recreate` strategy), receive the new tokens.
9. Each agent attempts announce; signature verifies; runtime endpoints populate `clint_runtime_endpoints`; vetra.to UI shows them.

Steps 4-5 are coupled: the new package version embeds both the processor (§5.2, §5.4) and the subgraph (§5.3) and the shared module (§5.1). They roll together.

## 8. Failure modes

- **Secret missing / unreadable.** `loadClintAnnounceSecret` throws at startup; the staging switchboard pod fails to come up (CrashLoopBackOff). Operationally visible. Detected before any agent tries to announce.
- **Secret rotated mid-flight.** All tokens in pod env immediately invalidate. Agents log 401 until their tenant YAML re-emits with a new signed token (next reconcile of each env doc) and the pod cycles. Acceptable: rotation is a deliberate action, expected window of disruption.
- **`documentId` or `prefix` contains a literal `|`.** Currently impossible — UUIDs don't contain `|`; service prefixes are validated as `[a-z0-9-]+` in the modal and the doc-model reducer. If a future change relaxes those constraints, the `|` separator becomes ambiguous and we'd need a different framing (length-prefix or JSON). Out of scope; flagged in §9 as a thing to watch.
- **Drift between processor and resolver versions.** Both live in `vetra-cloud-package` and ship together. As long as the staging switchboard runs a single version (true today: `PH_REGISTRY_PACKAGES` pins one), processor and resolver use the same `signClintAnnounceToken` implementation.

## 9. Open questions

- **Per-environment secrets vs single global.** v1 uses one global secret. If/when multi-env isolation becomes a real concern (e.g. compromised env shouldn't compromise all), shift to per-env secrets minted alongside the env doc and stored in the env's own `cnpg`. Not warranted today.
- **Token revocation per-service.** v1 revokes by rotating the global secret (heavy hammer). Per-service revocation would require an explicit deny-list, reintroducing state. Defer until a real use case appears.
- **Separator collision risk.** If service prefix validation ever loosens to allow `|`, the framing must be reworked. Add a guard in `signClintAnnounceToken` that rejects inputs containing `|` to fail-fast on that future regression.

## 10. Implementation order

This becomes the writing-plans input. Sketched here to validate scope:

1. **vetra-cloud-package — shared module** (`shared/clint-announce-token.ts`): write `signClintAnnounceToken`, `verifyClintAnnounceToken`, `loadClintAnnounceSecret` + tests (sign/verify roundtrip, mismatched inputs, missing secret throw, separator-collision guard).
2. **vetra-cloud-package — processor**: replace `ensureClintAnnounceTokens` with `mintClintAnnounceTokens` (sync, no db); update `generateValuesYaml` caller; update tests.
3. **vetra-cloud-package — subgraph resolver**: replace token DB lookup with `verifyClintAnnounceToken`; update tests.
4. **vetra-cloud-package — migration**: drop `clint_announce_tokens` table.
5. **powerhouse-k8s-hosting — chart**: extend `external-secret-gitops.yaml`, add `clintAnnounce` defaults to `values.yaml`.
6. **powerhouse-k8s-hosting — staging values**: enable `clintAnnounce`, add to `envSecret:`.
7. **OpenBao**: write the shared secret.
8. **Sequenced rollout** per §7 (chart change → secret materializes → publish package → bump staging → reconcile → agents cycle → announces flow).
9. **Validation**: after rollout, query `clintRuntimeEndpointsByEnv` for ph-pirate-wouter on `60eb44ad-…` — expect non-empty endpoints list with `prefix: "ph-pirate-wouter"`.
