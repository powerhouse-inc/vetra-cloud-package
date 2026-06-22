# Warm-Pool Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Commit style: small incremental commits, **no `Co-Authored-By` trailer** (see memory `commit-style`).

**Goal:** Make a warm-pool Studio claim activate the env in <30s (target <10s) by making "claimed" a *data* state instead of an *infrastructure* state — so a claim needs no gitops round-trip and no pod restart.

**Architecture:** Three independent gates move from infra/restart-bound to live-data:
1. **Agent abuse** → vetra-cli refuses to run without a credential (your idea). Self-contained, ships now.
2. **Network reachability** → stop rendering the per-pod default-deny NetworkPolicy for warm envs; the access gate becomes auth. Gated on a security audit.
3. **Access auth** → switchboard resolves the env owner from the reactor document per-request instead of a static `ADMINS` env (no restart). Heaviest; its own sub-project (switchboard image rebuild).

**Tech Stack:** TypeScript, vitest (vetra-cloud-package / reactor-api), jest (vetra-cli), Kubernetes/ArgoCD, GraphQL.

**Deploy mechanisms (differ per repo — critical):**
- `vetra-cli` → publish to registry (`reactor-project-publish` / npm publish) + bump `STUDIO_POOL_VERSION` in gitops; keeper recycles warm envs. (Like Phase 1.)
- `vetra-cloud-package` → publish + bump `PH_REGISTRY_PACKAGES` pin in `tenants/staging`. (Exactly Phase 1.)
- `@powerhousedao/reactor-api` → **baked into the switchboard container image** (`docker/Dockerfile`: `pnpm add @powerhousedao/switchboard@$TAG`). Change = monorepo PR → image rebuild via GH Actions → bump `switchboard` image tag in gitops → pod restart. **No runtime swap.**

---

## Build order & status

| Increment | Repo | Deploy | Risk | Status |
|---|---|---|---|---|
| 1. vetra-cli: require a credential (refuse gracefully) | vetra-cli | publish + STUDIO_POOL_VERSION | low | **DETAILED — execute now** |
| 1b. Wire `requireApiKey` on studio envs | vetra-cloud-package | PH_REGISTRY_PACKAGES bump | low | DETAILED |
| 2. Security audit: owner-null switchboard denies all surfaces | (probe staging) | n/a | n/a | DETAILED (gates #3) |
| 3. gitops: drop per-pod NetworkPolicy for warm envs | vetra-cloud-package | PH_REGISTRY_PACKAGES bump | med (needs #2 green) | DETAILED |
| 4. reactor-api: dynamic owner-based auth (+`ENV_DOCUMENT_ID` plumbing) | powerhouse, vetra-cloud-package, gitops | **switchboard image rebuild** | high | **SCOPED — separate plan + explicit go-ahead** |

Increments 1, 1b, 2 are safe to land immediately. #3 lands after #2 is green. #4 is the true <30s lever but is a switchboard-image change with a design question (multi-tenant: which env's owner?) — it gets its own plan and an explicit decision before building.

---

## Task 1: vetra-cli — refuse to run without a credential when required

**Files:**
- Create: `vetra-cli/vetra-cli/src/agents/require-key.ts`
- Create: `vetra-cli/vetra-cli/tests/agents/require-key.test.ts`
- Modify: `vetra-cli/vetra-cli/src/framework.ts` (add `requireApiKey` config field)
- Modify: `vetra-cli/vetra-cli/src/agents/agent.ts:41-46` (call the guard)

Rationale: today `agent.ts:41` (`resolved.kind === 'none'` = no API key AND no Claude subscription) falls back to a **demo agent**. For a provisioned cloud/studio env we instead want a clear refusal. Extract the decision into a pure function so it's unit-testable without the external token store.

- [ ] **Step 1: Write the failing test**

```typescript
// vetra-cli/vetra-cli/tests/agents/require-key.test.ts
import { describe, it, expect } from '@jest/globals';
import { assertCredentialIfRequired } from '../../src/agents/require-key.js';

describe('assertCredentialIfRequired', () => {
  it('throws a clear error when a credential is required but none resolved', () => {
    expect(() => assertCredentialIfRequired('none', true)).toThrow(/not provisioned/i);
  });
  it('does not throw when a credential is present (apiKey)', () => {
    expect(() => assertCredentialIfRequired('apiKey', true)).not.toThrow();
  });
  it('does not throw when a credential is present (subscription)', () => {
    expect(() => assertCredentialIfRequired('subscription', true)).not.toThrow();
  });
  it('does not throw when not required, even with no credential (local-dev demo path)', () => {
    expect(() => assertCredentialIfRequired('none', false)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd vetra-cli/vetra-cli && npx jest tests/agents/require-key.test.ts`
Expected: FAIL — cannot find module `../../src/agents/require-key.js`.

- [ ] **Step 3: Implement the guard**

```typescript
// vetra-cli/vetra-cli/src/agents/require-key.ts
import { formatLines } from '../helpers/cli-errors.js';

/** The credential states resolveClaudeAgentModel() can return. */
export type ResolvedCredentialKind = 'none' | 'apiKey' | 'subscription';

/**
 * Enforce the "this environment requires a credential" gate. When `required`
 * and no credential resolved (`kind === 'none'`), throw a clear, user-facing
 * error instead of silently degrading to the demo agent. Warm-pool studio envs
 * set requireApiKey=true so an unclaimed/key-less pod refuses to do agent work.
 */
export function assertCredentialIfRequired(
  kind: ResolvedCredentialKind,
  required: boolean,
): void {
  if (required && kind === 'none') {
    throw new Error(
      formatLines(
        'Vetra agent not provisioned: no Anthropic API key is available.',
        'This environment requires a key. If you just claimed it, wait a few seconds and retry.',
      ),
    );
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd vetra-cli/vetra-cli && npx jest tests/agents/require-key.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/f/projects/vetra-cli
git add vetra-cli/src/agents/require-key.ts vetra-cli/tests/agents/require-key.test.ts
git commit -m "feat(agent): add assertCredentialIfRequired guard"
```

- [ ] **Step 6: Add `requireApiKey` config field**

In `vetra-cli/vetra-cli/src/framework.ts`, inside the `configSchema` `@clint:begin framework-config` block, add:

```typescript
  requireApiKey: z.boolean().default(false).describe('Refuse to start the agent unless an Anthropic API key (or Claude subscription) is available. Set true for provisioned cloud/studio envs.'),
```

- [ ] **Step 7: Wire the guard into createAgent**

In `vetra-cli/vetra-cli/src/agents/agent.ts`, add the import near line 15:
```typescript
import { assertCredentialIfRequired } from './require-key.js';
```
Replace lines 41-46 (`if (resolved.kind === 'none') { … return createDemoAgent(); }`) with:
```typescript
  assertCredentialIfRequired(resolved.kind, ctx.config.requireApiKey);
  if (resolved.kind === 'none') {
    ctx.context.log?.info(
      '[agent] No API key and no Claude subscription session — run `claude-login` to authenticate.',
    );
    return createDemoAgent();
  }
```

- [ ] **Step 8: Typecheck + full test suite**

Run: `cd vetra-cli/vetra-cli && npx tsc --noEmit && npx jest`
Expected: clean typecheck, all tests pass.

- [ ] **Step 9: Commit**

```bash
cd /home/f/projects/vetra-cli
git add vetra-cli/src/framework.ts vetra-cli/src/agents/agent.ts
git commit -m "feat(agent): refuse without a credential when requireApiKey is set"
```

- [ ] **Step 10: Publish + deploy**

Bump `vetra-cli/vetra-cli/package.json` version (next `0.0.1-dev.N`), `npm publish` (registry `https://registry.dev.vetra.io`), then bump `STUDIO_POOL_VERSION` in `powerhouse-k8s-hosting/tenants/staging/powerhouse-values.yaml` to the new version, commit, push. Watch the keeper recycle the pool to the new version.

---

## Task 1b: vetra-cloud-package — set requireApiKey=true on studio envs

**Files:**
- Modify: `vetra-cloud-package/subgraphs/vetra-studio-pool/create-env.ts` (the `enableService` CLINT `env` array)

The keeper-created studio env already injects `VETRA_OBSERVABILITY_CONSENT`. Add the require-key flag the same way. **OPEN ITEM:** confirm the exact env-var name ph-clint maps `requireApiKey` to (check ph-clint config resolution; likely `REQUIRE_API_KEY` or a `VETRA_CLI_`-prefixed form). Use that name.

- [ ] **Step 1: Add the env entry**

In `create-env.ts`, in the `enableService` `clintConfig.env` array (currently `[{ name: "VETRA_OBSERVABILITY_CONSENT", value: "granted", isSecret: false }]`), add:
```typescript
{ name: "<RESOLVED_ENV_NAME>", value: "true", isSecret: false },
```

- [ ] **Step 2: Update create-env unit expectations** if any test asserts the env array; run `npx vitest run subgraphs/vetra-studio-pool`. Commit.

- [ ] **Step 3: Mirror in the frontend cold-provision path** — `vetra.to/modules/cloud/studio/constants.ts` `STUDIO_DEFAULT_ENV_VARS`, so cold-provisioned studios also require a key. Commit separately.

---

## Task 2: Security audit — does an owner-null switchboard deny all surfaces?

Dropping the NetworkPolicy (Task 3) makes auth the load-bearing gate. Verify an **unclaimed (owner-null)** warm env's switchboard rejects every surface without a valid admin token. Unclaimed envs are netpol-locked, so probe from *inside* the pod (localhost bypasses the netpol but still hits app-layer auth).

- [ ] **Step 1: Pick a locked env** (e.g. `kubectl get ns | grep -E 'gold-cat|true-toad'`) and find its clint switchboard port.

- [ ] **Step 2: From inside the pod, probe unauthenticated**:

```bash
kubectl -n <ns> exec <clint-pod> -c <container> -- sh -lc '
for path in /healthz /graphql "/graphql?query=%7B__typename%7D" /metrics; do
  echo "$path -> $(curl -s -o /dev/null -w "%{http_code}" -m 5 http://localhost:<port>$path)"
done'
```

- [ ] **Step 3: Record findings.** Any 200 on a data/introspection surface without auth = a leak that must be closed *before* Task 3. Health endpoints returning 200 is fine. Document the result in this plan file.

---

## Task 3: gitops — stop rendering the per-pod NetworkPolicy for warm/studio envs

**Files:**
- Modify: `vetra-cloud-package/processors/vetra-cloud-environment/gitops.ts:568` (`lines.push(\`      locked: ${!state.owner}\`);`)
- Test: `vetra-cloud-package/processors/vetra-cloud-environment/gitops.test.ts`

**Precondition:** Task 2 green (owner-null denies all). Behavior change: a Studio/warm env never renders `locked: true`. Detection of "is this a studio/warm env" — reuse the studio label/service shape (`STUDIO_ENV_LABEL` "Vetra Studio" / CLINT `vetra-agent` prefix). Keep `locked` for non-studio envs unchanged.

- [ ] **Step 1: Failing test** — owner-null Studio env renders `locked: false` (add to the existing "locks an unclaimed CLINT agent" describe block, asserting a studio-shaped state stays unlocked). Run `npx vitest run processors/vetra-cloud-environment/gitops.test.ts`, verify FAIL.

- [ ] **Step 2: Implement** — gate the `locked` value on non-studio: `const isStudio = state.label === 'Vetra Studio'; lines.push(\`      locked: ${!isStudio && !state.owner}\`);` (confirm the exact studio discriminator before coding).

- [ ] **Step 3:** Run tests (verify pass + the existing lock/unlock tests still hold). Commit. Publish + bump staging pin.

- [ ] **Step 4: Verify on staging** — claim a warm env (as in the Phase 1 e2e) and confirm it is reachable immediately (no ArgoCD netpol-prune wait), and that an *unclaimed* env still rejects access (auth gate).

---

## Task 4: reactor-api — dynamic owner-based auth (SEPARATE SUB-PLAN)

**Not detailed here — write its own plan before building.** Why separated:
- **Deploy is a switchboard image rebuild** (monorepo → GH Actions → image tag bump), not a runtime swap. High blast radius (affects every switchboard).
- **Design question:** the switchboard is multi-tenant (driveId per request, `ctx.user` = `{address,chainId,networkId}` only). For a per-env studio pod we want it to resolve *its own* env's owner. Cleanest: plumb a new `ENV_DOCUMENT_ID` env var (added in `gitops.ts` `switchboardAuthEnv`), and make `AuthService` resolve `getDocument(ENV_DOCUMENT_ID).state.global.owner` (cached, short TTL) as the admin **when that var is set**, else fall back to static `ADMINS` (backward compatible).
- **Refactor:** `AuthService` is constructed (server.ts ~498) before `reactorClient` exists (~913) — needs deferral or a setter.
- Tests: `powerhouse/packages/reactor-api/test/auth.service.test.ts` (vitest, mocks `@renown/sdk`).

Scope/sequence for that sub-plan: (a) plumb `ENV_DOCUMENT_ID` in gitops + create-env; (b) inject reactorClient into AuthService; (c) dynamic owner resolution with cache + owner-null-denies-all; (d) auth.service tests; (e) image build + staging deploy behind verification.

---

## Self-review notes
- Spec coverage: agent-key-gate (T1/1b), drop-netpol (T3), dynamic-auth (T4), security audit (T2) all mapped. Per-invocation key fetch intentionally dropped (out of scope — vetra-cli has no tenant/secret context).
- Open items flagged inline: exact `requireApiKey` env-var name (T1b), exact studio discriminator (T3). Resolve before coding those steps.
