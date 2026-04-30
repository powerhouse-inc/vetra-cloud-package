# CLINT Announce — Stateless Signed Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `clint_announce_tokens` DB-lookup auth on `announceClintEndpoints` with stateless HMAC-SHA256 signed tokens, eliminating the cross-component schema-coupling bug that's currently producing 401s.

**Architecture:** New shared module `vetra-cloud-package/shared/clint-announce-token.ts` exporting `sign / verify / load-secret` helpers. Processor's `gitops.ts` mints by signing instead of inserting into a table. Subgraph's `announceClintEndpoints` resolver verifies by re-signing in constant time. Migration drops the now-dead `clint_announce_tokens` table. Chart pulls a new `CLINT_ANNOUNCE_SECRET` from OpenBao via the existing `external-secret-gitops` template.

**Tech Stack:** TypeScript, Node `crypto` (HMAC-SHA256, timingSafeEqual), Kysely (Postgres migration), Vitest, Helm, ArgoCD, OpenBao + External-Secrets Operator.

**Repos touched:** `vetra-cloud-package` (code + migration + tests), `powerhouse-k8s-hosting` (chart + tenant values). Plus one `bao kv put` outside any repo.

**Design:** See `docs/superpowers/specs/2026-04-30-clint-announce-signed-tokens-design.md`.

---

## File Structure

| Path (repo) | Action | Responsibility |
|---|---|---|
| `vetra-cloud-package/shared/clint-announce-token.ts` | Create | `sign / verify / loadSecret` helpers — pure functions |
| `vetra-cloud-package/shared/__tests__/clint-announce-token.test.ts` | Create | Unit tests for the helpers |
| `vetra-cloud-package/processors/vetra-cloud-environment/gitops.ts` | Modify | Replace `ensureClintAnnounceTokens` (DB-backed) with `mintClintAnnounceTokens` (sync, signs) |
| `vetra-cloud-package/processors/vetra-cloud-environment/migrations.ts` | Modify | Drop `clint_announce_tokens` table; remove its `createTable` call |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/resolvers.ts` | Modify | Replace token DB-lookup in `announceClintEndpoints` with `verifyClintAnnounceToken` |
| `powerhouse-k8s-hosting/powerhouse-chart/values.yaml` | Modify | Add `switchboard.clintAnnounce` defaults |
| `powerhouse-k8s-hosting/powerhouse-chart/templates/external-secret-gitops.yaml` | Modify | Add `CLINT_ANNOUNCE_SECRET` data block (gated on `switchboard.clintAnnounce.enabled`) |
| `powerhouse-k8s-hosting/tenants/staging/powerhouse-values.yaml` | Modify | Enable `switchboard.clintAnnounce`; add `CLINT_ANNOUNCE_SECRET` to `envSecret:` |
| OpenBao path `powerhouse/shared/clint-announce` | Create | Shared 32-byte secret, base64-encoded, property `secret` |

---

## Phase A — Shared module (vetra-cloud-package)

### Task A.1: Create `clint-announce-token.ts` helpers + tests (TDD)

**Working directory:** `/home/froid/projects/powerhouse/vetra-cloud-package`
**Branch:** `dev` (this repo direct-commits to dev for code changes; CI auto-publishes to dev registry on push).

**Files:**
- Create: `shared/clint-announce-token.ts`
- Create: `shared/__tests__/clint-announce-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/__tests__/clint-announce-token.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  signClintAnnounceToken,
  verifyClintAnnounceToken,
  loadClintAnnounceSecret,
} from '../clint-announce-token.js';

const SECRET = Buffer.from('a'.repeat(32), 'utf-8');

describe('signClintAnnounceToken', () => {
  it('produces a deterministic 43-char base64url token', () => {
    const t1 = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    const t2 = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(t1).toBe(t2);
    expect(t1).toHaveLength(43);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different tokens for different inputs', () => {
    const a = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    const b = signClintAnnounceToken({ documentId: 'doc-2', prefix: 'a' }, SECRET);
    const c = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'b' }, SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('rejects inputs containing the | separator', () => {
    expect(() =>
      signClintAnnounceToken({ documentId: 'a|b', prefix: 'p' }, SECRET),
    ).toThrow(/separator/i);
    expect(() =>
      signClintAnnounceToken({ documentId: 'd', prefix: 'p|q' }, SECRET),
    ).toThrow(/separator/i);
  });
});

describe('verifyClintAnnounceToken', () => {
  it('verifies a token signed with the same input', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET)).toBe(true);
  });

  it('rejects a token with a different documentId', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'ph-pirate' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-2', prefix: 'ph-pirate' }, SECRET)).toBe(false);
  });

  it('rejects a token with a different prefix', () => {
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'b' }, SECRET)).toBe(false);
  });

  it('rejects a token with a different secret', () => {
    const other = Buffer.from('b'.repeat(32), 'utf-8');
    const t = signClintAnnounceToken({ documentId: 'doc-1', prefix: 'a' }, SECRET);
    expect(verifyClintAnnounceToken(t, { documentId: 'doc-1', prefix: 'a' }, other)).toBe(false);
  });

  it('rejects malformed token (length mismatch) without throwing', () => {
    expect(verifyClintAnnounceToken('short', { documentId: 'd', prefix: 'p' }, SECRET)).toBe(false);
    expect(verifyClintAnnounceToken('', { documentId: 'd', prefix: 'p' }, SECRET)).toBe(false);
  });
});

describe('loadClintAnnounceSecret', () => {
  it('decodes the env var as base64', () => {
    const original = process.env.CLINT_ANNOUNCE_SECRET;
    process.env.CLINT_ANNOUNCE_SECRET = Buffer.from('hello').toString('base64');
    try {
      const secret = loadClintAnnounceSecret();
      expect(secret).toBeInstanceOf(Buffer);
      expect(secret.toString('utf-8')).toBe('hello');
    } finally {
      if (original === undefined) delete process.env.CLINT_ANNOUNCE_SECRET;
      else process.env.CLINT_ANNOUNCE_SECRET = original;
    }
  });

  it('throws when the env var is missing', () => {
    const original = process.env.CLINT_ANNOUNCE_SECRET;
    delete process.env.CLINT_ANNOUNCE_SECRET;
    try {
      expect(() => loadClintAnnounceSecret()).toThrow(/CLINT_ANNOUNCE_SECRET/);
    } finally {
      if (original !== undefined) process.env.CLINT_ANNOUNCE_SECRET = original;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
pnpm vitest run shared/__tests__/clint-announce-token.test.ts 2>&1 | tail -10
```

Expected: FAIL — module `../clint-announce-token.js` not found.

- [ ] **Step 3: Implement the helpers**

Create `shared/clint-announce-token.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignInput = {
  documentId: string;
  prefix: string;
};

const SEPARATOR = '|';

function assertNoSeparator(input: SignInput): void {
  if (input.documentId.includes(SEPARATOR) || input.prefix.includes(SEPARATOR)) {
    throw new Error(
      `documentId or prefix must not contain the '${SEPARATOR}' separator`,
    );
  }
}

/**
 * Sign a CLINT announce token. Output is the base64url encoding of
 * HMAC-SHA256(secret, `${documentId}|${prefix}`). Always 43 characters
 * (32-byte HMAC-SHA256 output, base64url-encoded).
 */
export function signClintAnnounceToken(
  input: SignInput,
  secret: Buffer,
): string {
  assertNoSeparator(input);
  const payload = `${input.documentId}${SEPARATOR}${input.prefix}`;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Verify a presented CLINT announce token. Returns false on any
 * mismatch (wrong inputs, wrong secret, malformed token); never throws.
 * Comparison is constant-time for valid-length inputs.
 */
export function verifyClintAnnounceToken(
  presented: string,
  input: SignInput,
  secret: Buffer,
): boolean {
  let expected: string;
  try {
    expected = signClintAnnounceToken(input, secret);
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/**
 * Read the shared CLINT announce secret from `process.env.CLINT_ANNOUNCE_SECRET`,
 * decoding from base64. Throws on missing secret to fail-fast at boot —
 * silent fallback would hide a misconfigured ExternalSecret pipeline.
 */
export function loadClintAnnounceSecret(): Buffer {
  const raw = process.env.CLINT_ANNOUNCE_SECRET;
  if (!raw) {
    throw new Error(
      'CLINT_ANNOUNCE_SECRET env var is required for CLINT announce token signing/verification',
    );
  }
  return Buffer.from(raw, 'base64');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run shared/__tests__/clint-announce-token.test.ts 2>&1 | tail -10
```

Expected: PASS — 9 tests across the 3 describe blocks.

- [ ] **Step 5: Run typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add shared/clint-announce-token.ts shared/__tests__/clint-announce-token.test.ts
git commit -m "feat(shared): clint announce token sign/verify helpers"
```

---

### Task A.2: Replace `ensureClintAnnounceTokens` with `mintClintAnnounceTokens` (sync)

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts`

- [ ] **Step 1: Locate and read the current `ensureClintAnnounceTokens` function**

```bash
grep -n "ensureClintAnnounceTokens\|mintClintAnnounceTokens" processors/vetra-cloud-environment/gitops.ts
```

The function is currently at gitops.ts:362-396 (async, takes `db, state, documentId`). The caller is `generateValuesYaml` (around line 488 area, after the registry section).

- [ ] **Step 2: Add the import**

In `processors/vetra-cloud-environment/gitops.ts`, add to the import block at the top:

```ts
import {
  loadClintAnnounceSecret,
  signClintAnnounceToken,
} from "../../shared/clint-announce-token.js";
```

- [ ] **Step 3: Replace `ensureClintAnnounceTokens` with `mintClintAnnounceTokens`**

Replace the existing `ensureClintAnnounceTokens` function (the entire `async function ensureClintAnnounceTokens(...)` block, including the JSDoc) with:

```ts
/**
 * Mint announce tokens for every CLINT service in the state. Tokens are
 * stateless HMAC-SHA256 signatures over `${documentId}|${prefix}` using
 * the shared CLINT_ANNOUNCE_SECRET. Same inputs → same token; no DB
 * write or read. Returns a `prefix → token` map matching the previous
 * (DB-backed) shape so callers don't need to change.
 */
function mintClintAnnounceTokens(
  state: VetraCloudEnvironmentState,
  documentId: string,
): Record<string, string> {
  const secret = loadClintAnnounceSecret();
  const clintServices = (state.services ?? []).filter(
    (s) => s.type === "CLINT" && s.enabled,
  );
  const tokens: Record<string, string> = {};
  for (const svc of clintServices) {
    tokens[svc.prefix] = signClintAnnounceToken(
      { documentId, prefix: svc.prefix },
      secret,
    );
  }
  return tokens;
}
```

- [ ] **Step 4: Update the caller in `generateValuesYaml`**

```bash
grep -n "ensureClintAnnounceTokens\|announceTokens =" processors/vetra-cloud-environment/gitops.ts
```

Find the call site (looks like `const announceTokens = await ensureClintAnnounceTokens(db, state, documentId);` — exact wording may differ; the awk-extracted text from earlier showed it inside `generateValuesYaml`).

Replace that line with:

```ts
const announceTokens = mintClintAnnounceTokens(state, documentId);
```

(Drop `await` and the `db` argument.)

- [ ] **Step 5: Update unit tests in `gitops.test.ts`**

```bash
grep -n "ensureClintAnnounceTokens\|mintClintAnnounceTokens\|clint_announce_tokens" processors/vetra-cloud-environment/gitops.test.ts
```

If the tests directly invoke `ensureClintAnnounceTokens`, rename the calls and remove any DB setup specific to `clint_announce_tokens`. If they only exercise `generateValuesYaml`, the tests should already work — set `process.env.CLINT_ANNOUNCE_SECRET` in test setup so `loadClintAnnounceSecret` doesn't throw:

If the test file has a top-level `beforeAll` or similar, add inside it (or at module top-level if the pattern is to use process.env directly):

```ts
import { Buffer } from 'node:buffer';

// Set before any test imports/runs that hit gitops.ts which now requires it.
process.env.CLINT_ANNOUNCE_SECRET = Buffer.from('test-secret-32-bytes-padding-'.padEnd(32, '_')).toString('base64');
```

The exact integration path depends on the existing test layout — read the file first and adapt.

- [ ] **Step 6: Run gitops tests**

```bash
pnpm vitest run processors/vetra-cloud-environment/gitops.test.ts 2>&1 | tail -15
```

Expected: PASS for all gitops tests. If a test fails because the YAML output's announce token has changed (it now does — old random vs new HMAC), that's expected — update the assertion to verify the token is non-empty and 43 chars rather than a fixed value:

```ts
expect(yaml).toMatch(/token: "[A-Za-z0-9_-]{43}"/);
```

…instead of asserting a hardcoded token string.

- [ ] **Step 7: Commit**

```bash
git add processors/vetra-cloud-environment/gitops.ts processors/vetra-cloud-environment/gitops.test.ts
git commit -m "feat(processor): mint CLINT announce tokens via HMAC instead of DB lookup"
```

---

### Task A.3: Replace token DB-lookup in `announceClintEndpoints` resolver

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/resolvers.ts`

- [ ] **Step 1: Locate the existing token-lookup block**

```bash
grep -n "clint_announce_tokens\|tokenRow\|announceClintEndpoints" subgraphs/vetra-cloud-observability/resolvers.ts | head -10
```

The block is around lines 645-665, inside `announceClintEndpoints`, between the auth-header parsing and the endpoint-upsert logic.

- [ ] **Step 2: Add import for the helpers**

At the top of `subgraphs/vetra-cloud-observability/resolvers.ts`, add to the existing imports:

```ts
import {
  loadClintAnnounceSecret,
  verifyClintAnnounceToken,
} from "../../shared/clint-announce-token.js";
```

- [ ] **Step 3: Cache the secret at resolver-factory startup**

Find the `createResolvers` function (or whatever wraps the resolver map). Near the top — alongside `const envDb = config.envDb;` — add:

```ts
const announceSecret = loadClintAnnounceSecret();
```

This makes the resolver fail-fast at module init if the secret isn't set, instead of throwing on every announce request.

- [ ] **Step 4: Replace the DB-lookup block with signature verification**

Find this block (currently around lines 645-665):

```ts
const tokenId = `${documentId}|${prefix}`;
// clint_announce_tokens lives in the processor's namespace.
const tokenRow = await envDb
  .selectFrom("clint_announce_tokens")
  .select(["token"])
  .where("id", "=", tokenId)
  .executeTakeFirst();
if (!tokenRow || tokenRow.token !== presented) {
  throw new Error("UNAUTHORIZED");
}
```

Replace with:

```ts
if (!verifyClintAnnounceToken(presented, { documentId, prefix }, announceSecret)) {
  throw new Error("UNAUTHORIZED");
}
```

- [ ] **Step 5: Confirm no other resolver in the file references `clint_announce_tokens`**

```bash
grep -n "clint_announce_tokens" subgraphs/vetra-cloud-observability/resolvers.ts
```

Expected: empty output. If anything remains, audit and remove.

- [ ] **Step 6: Typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: clean. If the import path doesn't resolve (`../../shared/clint-announce-token.js`), adjust based on the file's depth — `subgraphs/vetra-cloud-observability/resolvers.ts` is 2 levels deep, so `../../shared/clint-announce-token.js` is correct.

- [ ] **Step 7: Run any subgraph-related tests**

```bash
ls subgraphs/vetra-cloud-observability/__tests__/ 2>/dev/null || ls subgraphs/vetra-cloud-observability/*test* 2>/dev/null
```

If a test file exists, run it:

```bash
pnpm vitest run subgraphs/vetra-cloud-observability 2>&1 | tail -15
```

If no tests exist, skip — the helpers from Task A.1 already cover the verification logic; the resolver glue is exercised in the Phase F end-to-end smoke.

- [ ] **Step 8: Commit**

```bash
git add subgraphs/vetra-cloud-observability/resolvers.ts
git commit -m "feat(observability): verify CLINT announce tokens via HMAC signature"
```

---

### Task A.4: Drop `clint_announce_tokens` table in migrations

**Files:**
- Modify: `processors/vetra-cloud-environment/migrations.ts`

- [ ] **Step 1: Locate the existing createTable block**

```bash
grep -n "clint_announce_tokens" processors/vetra-cloud-environment/migrations.ts
```

There's a `createTable("clint_announce_tokens")` call inside `up()` (around lines 88-102) and a `dropTable("clint_announce_tokens")` inside `down()` (around line 106).

- [ ] **Step 2: Replace the createTable block with a try/catch dropTable**

Replace:

```ts
  // Bearer tokens for clint agent announcement URLs. Keyed by
  // (documentId, prefix) so a single env can host N agents, each with
  // its own token. The observability subgraph reads this table cross-
  // namespace (the same way it reads `environments` for the
  // myEnvironments resolver) to validate incoming announcements.
  await db.schema
    .createTable("clint_announce_tokens")
    .addColumn("id", "varchar(320)")
    .addColumn("documentId", "varchar(255)")
    .addColumn("prefix", "varchar(64)")
    .addColumn("token", "varchar(128)")
    .addColumn("createdAt", "varchar(64)")
    .addPrimaryKeyConstraint("clint_announce_tokens_pkey", ["id"])
    .ifNotExists()
    .execute();
```

with:

```ts
  // Drop legacy clint_announce_tokens table if present — replaced by
  // stateless HMAC-signed tokens. Wrapped in try/catch because
  // ifExists() isn't supported by all Kysely dialects in the same way
  // and a fresh install never had the table.
  try {
    await db.schema.dropTable("clint_announce_tokens").execute();
  } catch {
    // Table doesn't exist — expected on fresh installs and on the
    // second run after the drop.
  }
```

- [ ] **Step 3: Update the down() function**

Replace:

```ts
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("clint_announce_tokens").execute();
  await db.schema.dropTable("environments").execute();
}
```

with:

```ts
export async function down(db: Kysely<any>): Promise<void> {
  // clint_announce_tokens is removed by `up()` and isn't recreated by
  // this version of the package; leave the dropTable out so we don't
  // race a successful no-op against a not-found error here.
  await db.schema.dropTable("environments").execute();
}
```

- [ ] **Step 4: Confirm no other code references the table**

```bash
grep -rn "clint_announce_tokens" --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist 2>&1 | head -10
```

Expected: empty output (or comments only). If the resolver still references it, Task A.3 wasn't fully applied — fix it.

- [ ] **Step 5: Typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add processors/vetra-cloud-environment/migrations.ts
git commit -m "feat(processor): drop clint_announce_tokens table — HMAC tokens are stateless"
```

---

### Task A.5: Push to dev (CI auto-publishes)

**Files:** none modified.

- [ ] **Step 1: Verify the four code commits are present**

```bash
git log --oneline origin/dev..HEAD
```

Expected: four commits in order:
1. `feat(shared): clint announce token sign/verify helpers`
2. `feat(processor): mint CLINT announce tokens via HMAC instead of DB lookup`
3. `feat(observability): verify CLINT announce tokens via HMAC signature`
4. `feat(processor): drop clint_announce_tokens table — HMAC tokens are stateless`

- [ ] **Step 2: Push**

```bash
git push origin dev
```

CI runs the publish workflow (`.github/workflows/sync-and-publish.yml`) which bumps the prerelease version and publishes to `registry.dev.vetra.io` under tag `dev`.

- [ ] **Step 3: Watch CI and capture the published version**

```bash
gh run list --workflow sync-and-publish.yml --limit 1
```

Wait until status `completed success` (~2 min). Then:

```bash
curl -s 'https://registry.dev.vetra.io/@powerhousedao/vetra-cloud-package' | python3 -c "import sys,json;d=json.load(sys.stdin);print('dev tag:',d['dist-tags']['dev'])"
```

Capture the version (e.g. `0.0.3-dev.57`). It's needed for Phase D below.

---

## Phase B — Chart change (powerhouse-k8s-hosting)

### Task B.1: Add `switchboard.clintAnnounce` defaults to chart values

**Working directory:** `/home/froid/projects/powerhouse/powerhouse-k8s-hosting`
**Branch:** `main` (direct-commits per repo convention).

**Files:**
- Modify: `powerhouse-chart/values.yaml`

- [ ] **Step 1: Locate the switchboard.cloudAutoUpdate block (template for our new block)**

```bash
grep -n "cloudAutoUpdate:\|^switchboard:" powerhouse-chart/values.yaml | head -10
```

Find the existing `cloudAutoUpdate:` block under `switchboard:` (it has `enabled: false` and `secretPath: powerhouse/shared/cloud-auto-update`).

- [ ] **Step 2: Add `clintAnnounce:` block alongside it**

Right after the `cloudAutoUpdate:` block (under `switchboard:`), add:

```yaml
  clintAnnounce:
    # When enabled, the chart pulls a shared secret from OpenBao at
    # `secretPath` (property `secret`) and surfaces it as
    # CLINT_ANNOUNCE_SECRET on the switchboard pod. Required by
    # vetra-cloud-package's processor (to mint CLINT announce tokens)
    # and observability subgraph (to verify them).
    enabled: false
    secretPath: powerhouse/shared/clint-announce
```

Indentation must match `cloudAutoUpdate:` exactly (two-space indent under `switchboard:`).

- [ ] **Step 3: Verify the chart still parses**

```bash
helm lint powerhouse-chart 2>&1 | tail -5
```

Expected: `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 4: Commit**

```bash
git add powerhouse-chart/values.yaml
git commit -m "feat(chart): add switchboard.clintAnnounce defaults"
```

---

### Task B.2: Add `CLINT_ANNOUNCE_SECRET` to the external-secret-gitops template

**Files:**
- Modify: `powerhouse-chart/templates/external-secret-gitops.yaml`

- [ ] **Step 1: Read the existing template**

```bash
cat powerhouse-chart/templates/external-secret-gitops.yaml
```

The `data:` list ends with the optional `CLOUD_AUTO_UPDATE_SECRET` block, then `{{- end }}` for the template's outermost `{{- if and .Values.switchboard.gitops ... }}`.

- [ ] **Step 2: Add a third gated `secretKey` block**

Append immediately after the `CLOUD_AUTO_UPDATE_SECRET` `{{- end }}` and before the outermost `{{- end }}`:

```yaml
    {{- if and .Values.switchboard.clintAnnounce (eq (.Values.switchboard.clintAnnounce.enabled | toString) "true") }}
    - secretKey: CLINT_ANNOUNCE_SECRET
      remoteRef:
        key: {{ .Values.switchboard.clintAnnounce.secretPath | default "powerhouse/shared/clint-announce" }}
        property: secret
    {{- end }}
```

- [ ] **Step 3: Render with clintAnnounce disabled (default — backwards-compat)**

```bash
helm template test powerhouse-chart \
  --set switchboard.gitops.enabled=true \
  2>&1 \
  | awk '/kind: ExternalSecret/,/^---$/' \
  | grep "secretKey:"
```

Expected: only `GITOPS_REPO_URL`, `GITOPS_GITHUB_PAT` (no `CLOUD_AUTO_UPDATE_SECRET` either, since it's also default-off; no `CLINT_ANNOUNCE_SECRET`).

- [ ] **Step 4: Render with clintAnnounce enabled**

```bash
helm template test powerhouse-chart \
  --set switchboard.gitops.enabled=true \
  --set switchboard.clintAnnounce.enabled=true \
  2>&1 \
  | awk '/kind: ExternalSecret/,/^---$/' \
  | grep -A 3 "CLINT_ANNOUNCE_SECRET"
```

Expected:
```
    - secretKey: CLINT_ANNOUNCE_SECRET
      remoteRef:
        key: powerhouse/shared/clint-announce
        property: secret
```

- [ ] **Step 5: Render with custom secretPath**

```bash
helm template test powerhouse-chart \
  --set switchboard.gitops.enabled=true \
  --set switchboard.clintAnnounce.enabled=true \
  --set switchboard.clintAnnounce.secretPath=tenants/staging/clint-announce \
  2>&1 \
  | awk '/kind: ExternalSecret/,/^---$/' \
  | grep -A 3 "CLINT_ANNOUNCE_SECRET"
```

Expected:
```
    - secretKey: CLINT_ANNOUNCE_SECRET
      remoteRef:
        key: tenants/staging/clint-announce
        property: secret
```

- [ ] **Step 6: Commit**

```bash
git add powerhouse-chart/templates/external-secret-gitops.yaml
git commit -m "feat(chart): pull CLINT_ANNOUNCE_SECRET from OpenBao when clintAnnounce.enabled"
```

---

## Phase C — Write the OpenBao secret

### Task C.1: Generate + store the shared CLINT announce secret

**Files:** none modified (operations).

This step happens BEFORE the staging-tenant flip in Phase D; once the chart change in Phase B is deployed and the staging tenant enables `clintAnnounce`, the ExternalSecret pipeline will look for `powerhouse/shared/clint-announce` in OpenBao. If it's not there, the External-Secrets Operator enters an error state and the switchboard pod fails to receive its env Secret.

- [ ] **Step 1: Generate a 32-byte random secret + write to OpenBao**

```bash
SECRET=$(openssl rand -base64 32)
bao kv put powerhouse/shared/clint-announce secret="$SECRET"
```

- [ ] **Step 2: Verify it's readable**

```bash
bao kv get -field=secret powerhouse/shared/clint-announce
```

Expected: a 44-character base64 string (32 bytes encoded). DO NOT echo it elsewhere.

- [ ] **Step 3: Confirm via the External-Secrets path**

The `external-secret-gitops` template references `key: powerhouse/shared/clint-announce, property: secret`. The OpenBao path layout matches what `bao kv put` produced. No further action needed here.

---

## Phase D — Bump staging tenant + cut over

### Task D.1: Push chart change to k8s-hosting `main`

**Files:** none modified (operations).

- [ ] **Step 1: Verify both chart commits are local**

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-hosting
git log --oneline origin/main..HEAD
```

Expected:
1. `feat(chart): pull CLINT_ANNOUNCE_SECRET from OpenBao when clintAnnounce.enabled`
2. `feat(chart): add switchboard.clintAnnounce defaults`

- [ ] **Step 2: Push**

```bash
git push origin main
```

If the push is rejected because of new processor-emitted tenant updates upstream:

```bash
git pull --rebase origin main
git push origin main
```

ArgoCD picks up the chart change on its next sync. The `external-secret-gitops` template now CAN render the `CLINT_ANNOUNCE_SECRET` block, but it's still gated on `clintAnnounce.enabled` (still `false` in staging until D.3).

---

### Task D.2: Bump staging's `vetra-cloud-package` version (PH_REGISTRY_PACKAGES)

**Files:**
- Modify: `tenants/staging/powerhouse-values.yaml`

- [ ] **Step 1: Confirm the new version published in Phase A.5**

```bash
curl -s 'https://registry.dev.vetra.io/@powerhousedao/vetra-cloud-package' | python3 -c "import sys,json;d=json.load(sys.stdin);print('latest dev:',d['dist-tags']['dev'])"
```

Note the version (e.g. `0.0.3-dev.57`). Use it in Step 2.

- [ ] **Step 2: Replace both occurrences of the old version**

```bash
grep -n 'PH_REGISTRY_PACKAGES.*vetra-cloud-package' tenants/staging/powerhouse-values.yaml
```

Two lines (switchboard env, connect env) both reference `@powerhousedao/vetra-cloud-package@0.0.3-dev.56`. Replace both with the new dev version. Use Edit with `replace_all: true` if the strings are identical.

The expected result for both lines:

```yaml
    PH_REGISTRY_PACKAGES: "@powerhousedao/vetra-cloud-package@<NEW_VERSION>"
```

(Replace `<NEW_VERSION>` with whatever Step 1 reported, e.g. `0.0.3-dev.57`.)

---

### Task D.3: Enable `clintAnnounce` + add to `envSecret` in staging

**Files:**
- Modify: `tenants/staging/powerhouse-values.yaml`

- [ ] **Step 1: Add `clintAnnounce: { enabled: true }` under switchboard**

Find the existing `cloudAutoUpdate:` block under `switchboard:`:

```yaml
  cloudAutoUpdate:
    enabled: true
```

Add immediately after:

```yaml
  clintAnnounce:
    enabled: true
```

Indentation matches `cloudAutoUpdate:` (two-space under `switchboard:`).

- [ ] **Step 2: Add `CLINT_ANNOUNCE_SECRET` to the envSecret block**

Find the existing `envSecret:` block under switchboard (it currently lists `GITOPS_REPO_URL`, `GITOPS_GITHUB_PAT`, `CLOUD_AUTO_UPDATE_SECRET`):

```yaml
  envSecret:
    GITOPS_REPO_URL: GITOPS_REPO_URL
    GITOPS_GITHUB_PAT: GITOPS_GITHUB_PAT
    CLOUD_AUTO_UPDATE_SECRET: CLOUD_AUTO_UPDATE_SECRET
```

Add a fourth line:

```yaml
  envSecret:
    GITOPS_REPO_URL: GITOPS_REPO_URL
    GITOPS_GITHUB_PAT: GITOPS_GITHUB_PAT
    CLOUD_AUTO_UPDATE_SECRET: CLOUD_AUTO_UPDATE_SECRET
    CLINT_ANNOUNCE_SECRET: CLINT_ANNOUNCE_SECRET
```

- [ ] **Step 3: Verify the rendered staging deployment has the new env var**

```bash
helm template staging powerhouse-chart -f tenants/staging/powerhouse-values.yaml \
  2>&1 \
  | awk '/kind: Deployment/,/^---$/' \
  | grep -B 1 -A 4 "name: CLINT_ANNOUNCE_SECRET"
```

Expected: the env var sourced from `secretKeyRef`:

```yaml
        - name: CLINT_ANNOUNCE_SECRET
          valueFrom:
            secretKeyRef:
              key: CLINT_ANNOUNCE_SECRET
              name: powerhouse-staging-switchboard-env
```

- [ ] **Step 4: Verify the ExternalSecret manifest will request CLINT_ANNOUNCE_SECRET from OpenBao**

```bash
helm template staging powerhouse-chart -f tenants/staging/powerhouse-values.yaml \
  2>&1 \
  | awk '/kind: ExternalSecret/,/^---$/' \
  | grep -A 3 "CLINT_ANNOUNCE_SECRET"
```

Expected:

```yaml
    - secretKey: CLINT_ANNOUNCE_SECRET
      remoteRef:
        key: powerhouse/shared/clint-announce
        property: secret
```

- [ ] **Step 5: Commit + push**

```bash
git add tenants/staging/powerhouse-values.yaml
git commit -m "chore(staging): bump vetra-cloud-package + enable CLINT_ANNOUNCE_SECRET

Bumps to a vetra-cloud-package version that uses HMAC-signed CLINT
announce tokens (no DB lookup), and surfaces the shared
CLINT_ANNOUNCE_SECRET on the switchboard pod via the
external-secret-gitops ExternalSecret pipeline."
git push origin main
```

ArgoCD reconciles staging:
1. ExternalSecret materializes `CLINT_ANNOUNCE_SECRET` into the env Secret.
2. Switchboard deployment rolls (env Secret hash changed → pod template hash changed → new ReplicaSet).
3. New switchboard pod boots with `process.env.CLINT_ANNOUNCE_SECRET` set; `loadClintAnnounceSecret()` succeeds at module init.
4. Processor reconciles every env doc on startup; mints fresh signed tokens for every CLINT service; emits new tenant YAMLs.
5. ArgoCD applies tenant YAMLs; CLINT pods cycle (`Recreate` strategy) and pick up the new tokens.

---

## Phase E — Validation

### Task E.1: Verify staging switchboard restarted with the new contract

**Files:** none.

- [ ] **Step 1: Confirm switchboard pod is fresh + has the secret**

```bash
kubectl -n staging get pods -l app.kubernetes.io/component=switchboard --field-selector=status.phase=Running
```

Note the pod name. Confirm it's a NEW pod (AGE < ~5 min after the push):

- [ ] **Step 2: Verify CLINT_ANNOUNCE_SECRET is set on the switchboard pod**

```bash
kubectl -n staging exec deploy/powerhouse-staging-switchboard -- /bin/sh -c 'test -n "$CLINT_ANNOUNCE_SECRET" && echo "SECRET_SET (length=$(printf %s \"$CLINT_ANNOUNCE_SECRET\" | wc -c))" || echo "SECRET_MISSING"'
```

Expected: `SECRET_SET (length=44)` (32 bytes base64-encoded). If `SECRET_MISSING`, ESO hasn't refreshed yet — wait 60s and retry.

- [ ] **Step 3: Tail switchboard logs for module-init errors**

```bash
kubectl -n staging logs deploy/powerhouse-staging-switchboard --tail=50 2>&1 | grep -iE "CLINT_ANNOUNCE_SECRET|loadClintAnnounceSecret|env var is required" | head -5
```

Expected: empty (no error). If `loadClintAnnounceSecret` threw, the pod would be in CrashLoopBackOff — fix Phase C/D before moving on.

---

### Task E.2: Force a CLINT pod cycle so it picks up the new signed token

**Files:** none.

The processor mints fresh tokens on the next reconcile of each env doc. Each env's tenant YAML is regenerated; ArgoCD applies; the CLINT pod cycles. To trigger this for the test env (`sure-fawn-71-60eb44ad`):

- [ ] **Step 1: Touch the env doc — any state-changing mutation triggers a reconcile**

The simplest mutation: rename the env's label to its current value (which the reducer treats as a no-op but the processor still reconciles on the resulting op). Or just ask the user to nudge anything in the env detail page (rename, save).

**Operator instruction:** open vetra.to → cloud → sure-fawn-71-60eb44ad → rename the env to its current label (or change anything trivial). This dispatches a SET_LABEL action.

Alternative — if the user wants to do it from the command line via the central GraphQL endpoint, that's a Renown-signed request which is awkward to script. The UI nudge is faster.

- [ ] **Step 2: Watch the processor regenerate tenant YAML**

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-hosting
until git pull --quiet 2>&1 && git log -1 --oneline tenants/sure-fawn-71-60eb44ad/powerhouse-values.yaml | grep -v "^$" > /dev/null; do
  sleep 5
done
echo "tenant YAML last update:"
git log -1 --pretty=format:'%h %s' tenants/sure-fawn-71-60eb44ad/powerhouse-values.yaml
```

Wait for a recent commit (last few minutes) — the processor pushes "chore(...): update tenant — synced from vetra-cloud-environment".

- [ ] **Step 3: Watch CLINT pod cycle in sure-fawn-71-60eb44ad**

```bash
NS=sure-fawn-71-60eb44ad
until kubectl -n "$NS" get pods -l app.kubernetes.io/component=clint -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.status.containerStatuses[0].ready}={.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null | head -1 | grep -E '^true=' > /dev/null; do
  kubectl -n "$NS" get pods -l app.kubernetes.io/component=clint --no-headers 2>&1 | head -3
  sleep 10
done
echo "fresh ph-pirate-wouter pod ready:"
kubectl -n "$NS" get pods -l app.kubernetes.io/component=clint -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp,READY:.status.containerStatuses[0].ready
```

---

### Task E.3: Verify announce works end-to-end

**Files:** none.

- [ ] **Step 1: Wait for the agent to finish pnpm install + announce**

This takes 1-2 min after the pod is Running (pnpm install of ~1500 packages plus the agent's startup). Tail logs:

```bash
NS=sure-fawn-71-60eb44ad
until kubectl -n "$NS" logs -l app.kubernetes.io/component=clint --tail=50 2>&1 | grep -iE "announc|listening|serve" > /dev/null 2>&1; do
  sleep 10
  echo "still booting: $(kubectl -n "$NS" logs -l app.kubernetes.io/component=clint --tail=1 2>&1 | head -1 | head -c 100)"
done
kubectl -n "$NS" logs -l app.kubernetes.io/component=clint --tail=20 2>&1 | grep -iE "announc|listening|serve|UNAUTHORIZED|401"
```

Expected after the agent boots:
- One log line from the announce attempt — should NOT contain `Service announcement enabled but no URL configured` or `HTTP 401`.
- Ideally: silence (announce succeeded) OR an info-level success log if ph-clint emits one.

- [ ] **Step 2: Query the receiver subgraph**

```bash
DOC_ID=60eb44ad-160a-4b7d-84e1-d8d076b579ac
curl -s -X POST https://switchboard.staging.vetra.io/graphql \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"{ clintRuntimeEndpointsByEnv(documentId: \\\"$DOC_ID\\\") { prefix endpoints { id type port status } } }\"}" \
  --max-time 10 | python3 -m json.tool
```

Expected: `data.clintRuntimeEndpointsByEnv` is non-empty, with at least one entry whose `prefix` is `ph-pirate-wouter` and whose `endpoints` list has 1+ entries with `type ∈ {api-graphql, api-mcp, website}`.

If empty:
- The pod hasn't tried to announce yet. Wait another 30s.
- If still empty after 2 min and logs show no error, check switchboard logs for incoming announce requests:
  ```bash
  kubectl -n staging logs deploy/powerhouse-staging-switchboard --tail=200 | grep -iE "announce|UNAUTHORIZED" | tail -10
  ```

- [ ] **Step 3: Confirm vetra.to UI shows the runtime endpoints**

Operator instruction: open `https://staging.vetra.io/cloud/<sure-fawn-71-doc-id>` → expand the ph-pirate-wouter agent card → "Endpoints" section should populate within ~15s (AgentCard polling cadence).

If empty, check that the prefix in `clintRuntimeEndpointsByEnv` (Step 2) actually matches `agent.name` from the doc model. The chart's hostname pin (from the prior spec) makes them aligned; mismatch indicates a regression there.

---

## Phase F — Mark Shipped

### Task F.1: Flip spec status

**Files:**
- Modify: `vetra-cloud-package/docs/superpowers/specs/2026-04-30-clint-announce-signed-tokens-design.md`

- [ ] **Step 1: Replace the status header**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
sed -i 's/^\*\*Status:\*\* Draft/**Status:** Shipped/' docs/superpowers/specs/2026-04-30-clint-announce-signed-tokens-design.md
grep '^\*\*Status:' docs/superpowers/specs/2026-04-30-clint-announce-signed-tokens-design.md
```

Expected: `**Status:** Shipped`.

- [ ] **Step 2: Commit + push**

```bash
git add docs/superpowers/specs/2026-04-30-clint-announce-signed-tokens-design.md
git commit -m "docs(observability): mark clint-announce-signed-tokens spec as Shipped"
git push origin dev
```
