# Vetra Cloud Secrets Subgraph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new subgraph that lets tenants manage environment variables and secrets via GraphQL, persisted in Postgres + OpenBao KV, synced to the GitOps repo as ConfigMap + ExternalSecret manifests.

**Architecture:** New `vetra-cloud-secrets` subgraph extending `BaseSubgraph`. Env vars stored plaintext in Postgres, secrets stored in OpenBao KV v2 with metadata in Postgres. On every mutation, the subgraph regenerates YAML manifests and pushes them to the GitOps repo via ephemeral git clone. The processor's Helm values are updated to reference the ConfigMap and Secret via `envFrom`.

**Tech Stack:** TypeScript, Kysely (Postgres), OpenBao KV v2 API, graphql-tag, vitest, pglite (test DB)

**Spec:** `docs/superpowers/specs/2026-04-07-vetra-cloud-secrets-subgraph-design.md`

---

## File Structure

### New files (subgraph)

| File | Responsibility |
|------|---------------|
| `subgraphs/vetra-cloud-secrets/db/schema.ts` | Kysely table interfaces for `tenant_env_vars` and `tenant_secrets` |
| `subgraphs/vetra-cloud-secrets/db/migrations.ts` | `up()` / `down()` table creation |
| `subgraphs/vetra-cloud-secrets/openbao-kv.ts` | OpenBao KV v2 client (auth + read/write/delete) |
| `subgraphs/vetra-cloud-secrets/gitops-sync.ts` | ConfigMap + ExternalSecret YAML generation, ephemeral clone + push |
| `subgraphs/vetra-cloud-secrets/schema.ts` | GraphQL type definitions |
| `subgraphs/vetra-cloud-secrets/resolvers.ts` | Query + Mutation resolver factory |
| `subgraphs/vetra-cloud-secrets/index.ts` | `VetraCloudSecretsSubgraph` class |

### New files (tests)

| File | Responsibility |
|------|---------------|
| `subgraphs/vetra-cloud-secrets/__tests__/db-migrations.test.ts` | Migration + CRUD tests |
| `subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts` | OpenBao KV client tests (mocked fetch) |
| `subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts` | YAML generation tests |
| `subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts` | Full resolver tests (pglite + mocked OpenBao + mocked gitops) |

### Modified files

| File | Change |
|------|--------|
| `subgraphs/index.ts` | Add export for `VetraCloudSecretsSubgraph` |
| `processors/vetra-cloud-environment/gitops.ts` | Add `envFrom` to `generateValuesYaml()` |

---

## Task 1: Database Schema & Migrations

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/db/schema.ts`
- Create: `subgraphs/vetra-cloud-secrets/db/migrations.ts`
- Create: `subgraphs/vetra-cloud-secrets/__tests__/db-migrations.test.ts`

- [ ] **Step 1: Create the Kysely table interfaces**

Create `subgraphs/vetra-cloud-secrets/db/schema.ts`:

```typescript
export interface TenantEnvVars {
  tenantId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface TenantSecrets {
  tenantId: string;
  key: string;
  updatedAt: string;
}

export interface SecretsDB {
  tenant_env_vars: TenantEnvVars;
  tenant_secrets: TenantSecrets;
}
```

- [ ] **Step 2: Create the migration functions**

Create `subgraphs/vetra-cloud-secrets/db/migrations.ts`:

```typescript
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("tenant_env_vars")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("key", "varchar(255)")
    .addColumn("value", "text")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("tenant_env_vars_pkey", ["tenantId", "key"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("tenant_secrets")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("key", "varchar(255)")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("tenant_secrets_pkey", ["tenantId", "key"])
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_secrets").execute();
  await db.schema.dropTable("tenant_env_vars").execute();
}
```

- [ ] **Step 3: Write the migration tests**

Create `subgraphs/vetra-cloud-secrets/__tests__/db-migrations.test.ts`:

```typescript
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up, down } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";

let db: Kysely<SecretsDB>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("db migrations", () => {
  it("creates both tables", async () => {
    const envRows = await db
      .selectFrom("tenant_env_vars")
      .selectAll()
      .execute();
    const secretRows = await db
      .selectFrom("tenant_secrets")
      .selectAll()
      .execute();

    expect(envRows).toEqual([]);
    expect(secretRows).toEqual([]);
  });

  it("inserts and selects tenant_env_vars", async () => {
    await db
      .insertInto("tenant_env_vars")
      .values({
        tenantId: "tenant-1",
        key: "NODE_ENV",
        value: "production",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("tenant_env_vars")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("NODE_ENV");
    expect(rows[0].value).toBe("production");
  });

  it("inserts and selects tenant_secrets", async () => {
    await db
      .insertInto("tenant_secrets")
      .values({
        tenantId: "tenant-1",
        key: "STRIPE_KEY",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("tenant_secrets")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("STRIPE_KEY");
  });

  it("enforces composite primary key on tenant_env_vars", async () => {
    await db
      .insertInto("tenant_env_vars")
      .values({
        tenantId: "tenant-1",
        key: "MY_VAR",
        value: "v1",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    await expect(
      db
        .insertInto("tenant_env_vars")
        .values({
          tenantId: "tenant-1",
          key: "MY_VAR",
          value: "v2",
          updatedAt: "2026-04-07T00:00:00Z",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("up is idempotent", async () => {
    await expect(up(db)).resolves.not.toThrow();
  });

  it("down drops all tables", async () => {
    await down(db);

    await expect(
      db.selectFrom("tenant_env_vars").selectAll().execute(),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/db-migrations.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/db/schema.ts subgraphs/vetra-cloud-secrets/db/migrations.ts subgraphs/vetra-cloud-secrets/__tests__/db-migrations.test.ts
git commit -m "feat(secrets): add database schema and migrations"
```

---

## Task 2: OpenBao KV v2 Client

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/openbao-kv.ts`
- Create: `subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts`

**Reference:** The existing `subgraphs/vetra-cloud-observability/openbao.ts` for auth pattern.

- [ ] **Step 1: Write the OpenBao KV client tests**

Create `subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts`:

```typescript
import { vi } from "vitest";
import { OpenBaoKVClient } from "../openbao-kv.js";

const BASE_URL = "http://openbao.example.com";
const MOCK_SA_TOKEN = "mock-sa-token";
const MOCK_VAULT_TOKEN = "s.mock-vault-token";

describe("OpenBaoKVClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockTokenReader: ReturnType<typeof vi.fn>;

  function makeClient(): OpenBaoKVClient {
    return new OpenBaoKVClient(BASE_URL, mockTokenReader as any);
  }

  /** Helper: queue an auth response followed by additional responses. */
  function mockAuth(...additionalResponses: object[]) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
    });
    for (const resp of additionalResponses) {
      mockFetch.mockResolvedValueOnce(resp);
    }
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockTokenReader = vi.fn().mockReturnValue(MOCK_SA_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe("authenticate", () => {
    it("POSTs to /v1/auth/kubernetes/login with vetra-secrets role", async () => {
      mockAuth();

      const client = makeClient();
      const token = await client.authenticate();

      expect(token).toBe(MOCK_VAULT_TOKEN);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/auth/kubernetes/login`);
      const body = JSON.parse(opts.body as string);
      expect(body.role).toBe("vetra-secrets");
    });

    it("throws on auth failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "permission denied",
      });

      await expect(makeClient().authenticate()).rejects.toThrow("403");
    });
  });

  describe("readSecrets", () => {
    it("returns data from KV v2 path", async () => {
      mockAuth({
        ok: true,
        json: async () => ({
          data: { data: { API_KEY: "abc123", DB_PASS: "secret" } },
        }),
      });

      const result = await makeClient().readSecrets("my-tenant-1234abcd");

      expect(result).toEqual({ API_KEY: "abc123", DB_PASS: "secret" });

      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(
        `${BASE_URL}/v1/kv/data/tenants/my-tenant-1234abcd/secrets`,
      );
      expect(opts.method).toBe("GET");
      expect(opts.headers["X-Vault-Token"]).toBe(MOCK_VAULT_TOKEN);
    });

    it("returns empty object when path has no data (404)", async () => {
      mockAuth({
        ok: false,
        status: 404,
        text: async () => "not found",
      });

      const result = await makeClient().readSecrets("new-tenant-00000000");
      expect(result).toEqual({});
    });

    it("throws on non-404 errors", async () => {
      mockAuth({
        ok: false,
        status: 500,
        text: async () => "internal error",
      });

      await expect(
        makeClient().readSecrets("my-tenant-1234abcd"),
      ).rejects.toThrow("500");
    });
  });

  describe("writeSecrets", () => {
    it("PUTs data to KV v2 path", async () => {
      mockAuth({ ok: true, json: async () => ({}) });

      await makeClient().writeSecrets("my-tenant-1234abcd", {
        API_KEY: "abc123",
        NEW_KEY: "new-value",
      });

      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(
        `${BASE_URL}/v1/kv/data/tenants/my-tenant-1234abcd/secrets`,
      );
      expect(opts.method).toBe("PUT");
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({
        data: { API_KEY: "abc123", NEW_KEY: "new-value" },
      });
    });

    it("throws on write failure", async () => {
      mockAuth({
        ok: false,
        status: 403,
        text: async () => "permission denied",
      });

      await expect(
        makeClient().writeSecrets("my-tenant-1234abcd", { KEY: "val" }),
      ).rejects.toThrow("403");
    });
  });

  describe("deleteSecret (single key)", () => {
    it("reads existing data, removes key, writes back, returns remaining", async () => {
      // Auth for read
      mockAuth({
        ok: true,
        json: async () => ({
          data: { data: { KEEP: "yes", REMOVE: "bye" } },
        }),
      });
      // Auth for write
      mockAuth({ ok: true, json: async () => ({}) });

      const remaining = await makeClient().deleteSecret(
        "my-tenant-1234abcd",
        "REMOVE",
      );

      expect(remaining).toEqual({ KEEP: "yes" });
    });

    it("returns empty object when deleting the last key", async () => {
      mockAuth({
        ok: true,
        json: async () => ({
          data: { data: { ONLY_KEY: "value" } },
        }),
      });
      mockAuth({ ok: true, json: async () => ({}) });

      const remaining = await makeClient().deleteSecret(
        "my-tenant-1234abcd",
        "ONLY_KEY",
      );

      expect(remaining).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts`
Expected: FAIL — `openbao-kv.js` does not exist.

- [ ] **Step 3: Implement the OpenBao KV client**

Create `subgraphs/vetra-cloud-secrets/openbao-kv.ts`:

```typescript
import { readFileSync } from "fs";

export type TokenReader = (path: string, encoding: BufferEncoding) => string;

const SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const ROLE = "vetra-secrets";

export class OpenBaoKVClient {
  private readonly addr: string;
  private readonly readToken: TokenReader;

  constructor(addr: string, tokenReader?: TokenReader) {
    this.addr = addr.replace(/\/$/, "");
    this.readToken = tokenReader ?? readFileSync;
  }

  async authenticate(): Promise<string> {
    const saToken = this.readToken(SA_TOKEN_PATH, "utf8").trim();

    const res = await fetch(`${this.addr}/v1/auth/kubernetes/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: saToken, role: ROLE }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao authentication failed (${res.status}): ${text}`,
      );
    }

    const json = (await res.json()) as {
      auth: { client_token: string };
    };
    return json.auth.client_token;
  }

  async readSecrets(tenantId: string): Promise<Record<string, string>> {
    const vaultToken = await this.authenticate();

    const res = await fetch(
      `${this.addr}/v1/kv/data/tenants/${tenantId}/secrets`,
      {
        method: "GET",
        headers: { "X-Vault-Token": vaultToken },
      },
    );

    if (res.status === 404) {
      return {};
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao readSecrets failed (${res.status}): ${text}`,
      );
    }

    const json = (await res.json()) as {
      data: { data: Record<string, string> };
    };
    return json.data.data;
  }

  async writeSecrets(
    tenantId: string,
    data: Record<string, string>,
  ): Promise<void> {
    const vaultToken = await this.authenticate();

    const res = await fetch(
      `${this.addr}/v1/kv/data/tenants/${tenantId}/secrets`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": vaultToken,
        },
        body: JSON.stringify({ data }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao writeSecrets failed (${res.status}): ${text}`,
      );
    }
  }

  async deleteSecret(
    tenantId: string,
    key: string,
  ): Promise<Record<string, string>> {
    const existing = await this.readSecrets(tenantId);
    const { [key]: _removed, ...remaining } = existing;
    await this.writeSecrets(tenantId, remaining);
    return remaining;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/openbao-kv.ts subgraphs/vetra-cloud-secrets/__tests__/openbao-kv.test.ts
git commit -m "feat(secrets): add OpenBao KV v2 client"
```

---

## Task 3: GitOps Sync (YAML Generation + Git Push)

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/gitops-sync.ts`
- Create: `subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts`

**Reference:** `processors/vetra-cloud-environment/gitops.ts` for ephemeral clone pattern.

- [ ] **Step 1: Write the YAML generation + sync tests**

Create `subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts`:

```typescript
import {
  generateConfigMapYaml,
  generateExternalSecretYaml,
} from "../gitops-sync.js";

describe("generateConfigMapYaml", () => {
  it("generates a ConfigMap with all env vars", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", [
      { key: "NODE_ENV", value: "production" },
      { key: "LOG_LEVEL", value: "info" },
    ]);

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("name: my-tenant-1234abcd-env");
    expect(yaml).toContain('NODE_ENV: "production"');
    expect(yaml).toContain('LOG_LEVEL: "info"');
  });

  it("generates an empty-data ConfigMap when no env vars", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", []);

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("name: my-tenant-1234abcd-env");
    expect(yaml).toContain("data: {}");
  });

  it("escapes special YAML characters in values", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", [
      { key: "MSG", value: 'hello "world"\nnewline' },
    ]);

    expect(yaml).toContain("MSG:");
    // Value should be quoted and escaped
    expect(yaml).not.toContain("\n");
  });
});

describe("generateExternalSecretYaml", () => {
  it("generates an ExternalSecret referencing all secret keys", () => {
    const yaml = generateExternalSecretYaml("my-tenant-1234abcd", [
      "API_KEY",
      "DB_PASSWORD",
    ]);

    expect(yaml).toContain("kind: ExternalSecret");
    expect(yaml).toContain("name: my-tenant-1234abcd-secrets");
    expect(yaml).toContain("secretStoreRef:");
    expect(yaml).toContain("name: openbao");
    expect(yaml).toContain("kind: ClusterSecretStore");
    expect(yaml).toContain("secretKey: API_KEY");
    expect(yaml).toContain("secretKey: DB_PASSWORD");
    expect(yaml).toContain(
      "key: tenants/my-tenant-1234abcd/secrets",
    );
    expect(yaml).toContain("property: API_KEY");
    expect(yaml).toContain("property: DB_PASSWORD");
  });

  it("generates ExternalSecret with empty data when no secrets", () => {
    const yaml = generateExternalSecretYaml("my-tenant-1234abcd", []);

    expect(yaml).toContain("kind: ExternalSecret");
    expect(yaml).toContain("data: []");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts`
Expected: FAIL — `gitops-sync.js` does not exist.

- [ ] **Step 3: Implement the gitops sync module**

Create `subgraphs/vetra-cloud-secrets/gitops-sync.ts`:

```typescript
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// YAML escaping
// ---------------------------------------------------------------------------

function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// YAML generators
// ---------------------------------------------------------------------------

export function generateConfigMapYaml(
  tenantId: string,
  envVars: Array<{ key: string; value: string }>,
): string {
  if (envVars.length === 0) {
    return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${tenantId}-env
data: {}
`;
  }

  const entries = envVars
    .map((e) => `  ${e.key}: ${yamlQuote(e.value)}`)
    .join("\n");

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${tenantId}-env
data:
${entries}
`;
}

export function generateExternalSecretYaml(
  tenantId: string,
  secretKeys: string[],
): string {
  if (secretKeys.length === 0) {
    return `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${tenantId}-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: ${tenantId}-secrets
  data: []
`;
  }

  const entries = secretKeys
    .map(
      (k) => `    - secretKey: ${k}
      remoteRef:
        key: tenants/${tenantId}/secrets
        property: ${k}`,
    )
    .join("\n");

  return `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${tenantId}-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: ${tenantId}-secrets
  data:
${entries}
`;
}

// ---------------------------------------------------------------------------
// Git helpers (same pattern as processors/vetra-cloud-environment/gitops.ts)
// ---------------------------------------------------------------------------

class GitMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const gitMutex = new GitMutex();
const MAX_PUSH_RETRIES = 3;

const GIT_AUTHOR_NAME =
  process.env.GITOPS_AUTHOR_NAME ?? "vetra-cloud-secrets";
const GIT_AUTHOR_EMAIL =
  process.env.GITOPS_AUTHOR_EMAIL ?? "noreply@vetra.io";

interface GitOpsConfig {
  repoUrl: string;
  remote: string;
  branch: string;
}

function getConfig(): GitOpsConfig {
  const repoUrl = getRepoUrl();
  return {
    repoUrl,
    remote: process.env.GITOPS_REMOTE ?? "origin",
    branch: process.env.GITOPS_BRANCH ?? "main",
  };
}

function getRepoUrl(): string {
  let url = process.env.GITOPS_REPO_URL;

  if (!url) {
    const repoPath = process.env.GITOPS_REPO_PATH;
    if (!repoPath) {
      throw new Error(
        "Either GITOPS_REPO_URL or GITOPS_REPO_PATH environment variable is required",
      );
    }
    const remote = process.env.GITOPS_REMOTE ?? "origin";
    url = execFileSync("git", ["-C", repoPath, "remote", "get-url", remote], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  }

  const pat = process.env.GITOPS_GITHUB_PAT;
  if (pat && url.startsWith("https://")) {
    const parsed = new URL(url);
    parsed.username = pat;
    parsed.password = "x-oauth-basic";
    url = parsed.toString();
  }

  return url;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return stdout.trim();
}

async function withEphemeralClone(
  fn: (cloneDir: string, config: GitOpsConfig) => Promise<void>,
): Promise<void> {
  const config = getConfig();
  const cloneDir = mkdtempSync(join(tmpdir(), "gitops-secrets-"));

  try {
    await git(
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        config.branch,
        config.repoUrl,
        ".",
      ],
      cloneDir,
    );

    await git(["config", "user.name", GIT_AUTHOR_NAME], cloneDir);
    await git(["config", "user.email", GIT_AUTHOR_EMAIL], cloneDir);

    await fn(cloneDir, config);
  } finally {
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function pushWithRetry(
  cloneDir: string,
  config: GitOpsConfig,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git(["push", config.remote, config.branch], cloneDir);
      return;
    } catch (error) {
      if (attempt === MAX_PUSH_RETRIES) throw error;
      await git(["fetch", config.remote, config.branch], cloneDir);
      try {
        await git(
          ["rebase", `${config.remote}/${config.branch}`],
          cloneDir,
        );
      } catch (rebaseError) {
        await git(["rebase", "--abort"], cloneDir);
        throw rebaseError;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public sync functions
// ---------------------------------------------------------------------------

export async function syncEnvVarsToGitops(
  tenantId: string,
  envVars: Array<{ key: string; value: string }>,
): Promise<void> {
  await gitMutex.acquire();
  try {
    await withEphemeralClone(async (cloneDir, config) => {
      const tenantDir = join(cloneDir, "tenants", tenantId);
      mkdirSync(tenantDir, { recursive: true });

      const filePath = join(tenantDir, "tenant-configmap.yaml");
      const yaml = generateConfigMapYaml(tenantId, envVars);
      writeFileSync(filePath, yaml, "utf-8");

      await git(
        ["add", `tenants/${tenantId}/tenant-configmap.yaml`],
        cloneDir,
      );

      const hasChanges = await git(
        ["diff", "--cached", "--name-only"],
        cloneDir,
      );
      if (!hasChanges) return;

      await git(
        ["commit", "-m", `chore(${tenantId}): update env vars`],
        cloneDir,
      );
      await pushWithRetry(cloneDir, config);
    });
  } finally {
    gitMutex.release();
  }
}

export async function syncSecretsToGitops(
  tenantId: string,
  secretKeys: string[],
): Promise<void> {
  await gitMutex.acquire();
  try {
    await withEphemeralClone(async (cloneDir, config) => {
      const tenantDir = join(cloneDir, "tenants", tenantId);
      mkdirSync(tenantDir, { recursive: true });

      const filePath = join(tenantDir, "tenant-external-secret.yaml");
      const yaml = generateExternalSecretYaml(tenantId, secretKeys);
      writeFileSync(filePath, yaml, "utf-8");

      await git(
        ["add", `tenants/${tenantId}/tenant-external-secret.yaml`],
        cloneDir,
      );

      const hasChanges = await git(
        ["diff", "--cached", "--name-only"],
        cloneDir,
      );
      if (!hasChanges) return;

      await git(
        ["commit", "-m", `chore(${tenantId}): update secrets`],
        cloneDir,
      );
      await pushWithRetry(cloneDir, config);
    });
  } finally {
    gitMutex.release();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts`
Expected: All 5 tests PASS (only YAML generation is tested — git operations are integration-tested).

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/gitops-sync.ts subgraphs/vetra-cloud-secrets/__tests__/gitops-sync.test.ts
git commit -m "feat(secrets): add gitops sync with ConfigMap and ExternalSecret generation"
```

---

## Task 4: GraphQL Schema

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/schema.ts`

- [ ] **Step 1: Create the GraphQL schema**

Create `subgraphs/vetra-cloud-secrets/schema.ts`:

```typescript
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type Query {
    envVars(tenantId: String!): [EnvVar!]!
    secrets(tenantId: String!): [SecretEntry!]!
  }

  type Mutation {
    setEnvVar(tenantId: String!, key: String!, value: String!): EnvVar!
    deleteEnvVar(tenantId: String!, key: String!): Boolean!
    setSecret(tenantId: String!, key: String!, value: String!): SecretEntry!
    deleteSecret(tenantId: String!, key: String!): Boolean!
  }

  type EnvVar {
    key: String!
    value: String!
  }

  type SecretEntry {
    key: String!
  }
`;
```

- [ ] **Step 2: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/schema.ts
git commit -m "feat(secrets): add GraphQL schema"
```

---

## Task 5: Resolvers

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/resolvers.ts`
- Create: `subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts`

- [ ] **Step 1: Write the resolver tests**

Create `subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts`:

```typescript
import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import type { OpenBaoKVClient } from "../openbao-kv.js";

let db: Kysely<SecretsDB>;

const mockOpenbao: OpenBaoKVClient = {
  authenticate: vi.fn(),
  readSecrets: vi.fn().mockResolvedValue({}),
  writeSecrets: vi.fn().mockResolvedValue(undefined),
  deleteSecret: vi.fn().mockResolvedValue({}),
} as any;

const mockGitopsSync = {
  syncEnvVarsToGitops: vi.fn().mockResolvedValue(undefined),
  syncSecretsToGitops: vi.fn().mockResolvedValue(undefined),
};

let resolvers: ReturnType<typeof createResolvers>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);

  vi.clearAllMocks();

  resolvers = createResolvers(db, mockOpenbao, mockGitopsSync);
});

afterEach(async () => {
  await db.destroy();
});

const query = () => resolvers.Query;
const mutation = () => resolvers.Mutation;

describe("Query", () => {
  describe("envVars", () => {
    it("returns empty array for unknown tenant", async () => {
      const result = await query().envVars(undefined, {
        tenantId: "unknown",
      });
      expect(result).toEqual([]);
    });

    it("returns all env vars for tenant", async () => {
      await db
        .insertInto("tenant_env_vars")
        .values([
          {
            tenantId: "t1",
            key: "NODE_ENV",
            value: "production",
            updatedAt: "2026-04-07T00:00:00Z",
          },
          {
            tenantId: "t1",
            key: "PORT",
            value: "3000",
            updatedAt: "2026-04-07T00:00:00Z",
          },
        ])
        .execute();

      const result = await query().envVars(undefined, { tenantId: "t1" });

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ key: "NODE_ENV", value: "production" });
      expect(result).toContainEqual({ key: "PORT", value: "3000" });
    });
  });

  describe("secrets", () => {
    it("returns empty array for unknown tenant", async () => {
      const result = await query().secrets(undefined, {
        tenantId: "unknown",
      });
      expect(result).toEqual([]);
    });

    it("returns secret keys only (no values)", async () => {
      await db
        .insertInto("tenant_secrets")
        .values([
          {
            tenantId: "t1",
            key: "API_KEY",
            updatedAt: "2026-04-07T00:00:00Z",
          },
          {
            tenantId: "t1",
            key: "DB_PASS",
            updatedAt: "2026-04-07T00:00:00Z",
          },
        ])
        .execute();

      const result = await query().secrets(undefined, { tenantId: "t1" });

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ key: "API_KEY" });
      expect(result).toContainEqual({ key: "DB_PASS" });
    });
  });
});

describe("Mutation", () => {
  describe("setEnvVar", () => {
    it("inserts a new env var and syncs to gitops", async () => {
      const result = await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "production",
      });

      expect(result).toEqual({ key: "NODE_ENV", value: "production" });

      const rows = await db
        .selectFrom("tenant_env_vars")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");

      expect(mockGitopsSync.syncEnvVarsToGitops).toHaveBeenCalledWith("t1", [
        { key: "NODE_ENV", value: "production" },
      ]);
    });

    it("updates an existing env var", async () => {
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "development",
      });
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "production",
      });

      const rows = await db
        .selectFrom("tenant_env_vars")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setEnvVar(undefined, {
          tenantId: "t1",
          key: "invalid-key",
          value: "val",
        }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteEnvVar", () => {
    it("returns true when key existed", async () => {
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "MY_VAR",
        value: "val",
      });

      const result = await mutation().deleteEnvVar(undefined, {
        tenantId: "t1",
        key: "MY_VAR",
      });

      expect(result).toBe(true);
      expect(mockGitopsSync.syncEnvVarsToGitops).toHaveBeenLastCalledWith(
        "t1",
        [],
      );
    });

    it("returns false when key did not exist", async () => {
      const result = await mutation().deleteEnvVar(undefined, {
        tenantId: "t1",
        key: "NOPE",
      });

      expect(result).toBe(false);
    });
  });

  describe("setSecret", () => {
    it("writes to OpenBao, saves metadata, syncs to gitops", async () => {
      vi.mocked(mockOpenbao.readSecrets).mockResolvedValueOnce({});

      const result = await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "secret-val",
      });

      expect(result).toEqual({ key: "API_KEY" });

      // OpenBao: read existing then write merged
      expect(mockOpenbao.readSecrets).toHaveBeenCalledWith("t1");
      expect(mockOpenbao.writeSecrets).toHaveBeenCalledWith("t1", {
        API_KEY: "secret-val",
      });

      // Postgres metadata
      const rows = await db
        .selectFrom("tenant_secrets")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);

      // GitOps
      expect(mockGitopsSync.syncSecretsToGitops).toHaveBeenCalledWith("t1", [
        "API_KEY",
      ]);
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setSecret(undefined, {
          tenantId: "t1",
          key: "bad key!",
          value: "val",
        }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteSecret", () => {
    it("removes from OpenBao, deletes metadata, syncs to gitops", async () => {
      // Seed a secret first
      vi.mocked(mockOpenbao.readSecrets).mockResolvedValueOnce({});
      await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "val",
      });

      vi.clearAllMocks();
      vi.mocked(mockOpenbao.deleteSecret).mockResolvedValueOnce({});

      const result = await mutation().deleteSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
      });

      expect(result).toBe(true);
      expect(mockOpenbao.deleteSecret).toHaveBeenCalledWith("t1", "API_KEY");
      expect(mockGitopsSync.syncSecretsToGitops).toHaveBeenCalledWith(
        "t1",
        [],
      );
    });

    it("returns false when key did not exist", async () => {
      vi.mocked(mockOpenbao.deleteSecret).mockResolvedValueOnce({});

      const result = await mutation().deleteSecret(undefined, {
        tenantId: "t1",
        key: "NOPE",
      });

      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts`
Expected: FAIL — `resolvers.js` does not exist.

- [ ] **Step 3: Implement the resolvers**

Create `subgraphs/vetra-cloud-secrets/resolvers.ts`:

```typescript
import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoKVClient } from "./openbao-kv.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid key "${key}": key must match ^[A-Z][A-Z0-9_]*$ (e.g. MY_VAR, API_KEY)`,
    );
  }
}

export interface GitopsSyncFns {
  syncEnvVarsToGitops(
    tenantId: string,
    envVars: Array<{ key: string; value: string }>,
  ): Promise<void>;
  syncSecretsToGitops(
    tenantId: string,
    secretKeys: string[],
  ): Promise<void>;
}

export function createResolvers(
  db: Kysely<SecretsDB>,
  openbao: OpenBaoKVClient,
  gitops: GitopsSyncFns,
): Record<string, any> {
  async function getAllEnvVars(
    tenantId: string,
  ): Promise<Array<{ key: string; value: string }>> {
    const rows = await db
      .selectFrom("tenant_env_vars")
      .select(["key", "value"])
      .where("tenantId", "=", tenantId)
      .orderBy("key", "asc")
      .execute();
    return rows;
  }

  async function getAllSecretKeys(tenantId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("tenant_secrets")
      .select("key")
      .where("tenantId", "=", tenantId)
      .orderBy("key", "asc")
      .execute();
    return rows.map((r) => r.key);
  }

  return {
    Query: {
      envVars: async (
        _parent: unknown,
        { tenantId }: { tenantId: string },
      ) => getAllEnvVars(tenantId),

      secrets: async (
        _parent: unknown,
        { tenantId }: { tenantId: string },
      ) => {
        const rows = await db
          .selectFrom("tenant_secrets")
          .select("key")
          .where("tenantId", "=", tenantId)
          .orderBy("key", "asc")
          .execute();
        return rows.map((r) => ({ key: r.key }));
      },
    },

    Mutation: {
      setEnvVar: async (
        _parent: unknown,
        {
          tenantId,
          key,
          value,
        }: { tenantId: string; key: string; value: string },
      ) => {
        validateKey(key);
        const now = new Date().toISOString();

        await db
          .insertInto("tenant_env_vars")
          .values({ tenantId, key, value, updatedAt: now })
          .onConflict((oc) =>
            oc
              .columns(["tenantId", "key"])
              .doUpdateSet({ value, updatedAt: now }),
          )
          .execute();

        const allEnvVars = await getAllEnvVars(tenantId);
        await gitops.syncEnvVarsToGitops(tenantId, allEnvVars);

        return { key, value };
      },

      deleteEnvVar: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
        const result = await db
          .deleteFrom("tenant_env_vars")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();

        const deleted = Number(result.numDeletedRows) > 0;

        if (deleted) {
          const allEnvVars = await getAllEnvVars(tenantId);
          await gitops.syncEnvVarsToGitops(tenantId, allEnvVars);
        }

        return deleted;
      },

      setSecret: async (
        _parent: unknown,
        {
          tenantId,
          key,
          value,
        }: { tenantId: string; key: string; value: string },
      ) => {
        validateKey(key);

        // Write to OpenBao KV (read-merge-write)
        const existing = await openbao.readSecrets(tenantId);
        await openbao.writeSecrets(tenantId, { ...existing, [key]: value });

        // Save metadata to Postgres
        const now = new Date().toISOString();
        await db
          .insertInto("tenant_secrets")
          .values({ tenantId, key, updatedAt: now })
          .onConflict((oc) =>
            oc
              .columns(["tenantId", "key"])
              .doUpdateSet({ updatedAt: now }),
          )
          .execute();

        // Sync ExternalSecret manifest to gitops
        const allKeys = await getAllSecretKeys(tenantId);
        await gitops.syncSecretsToGitops(tenantId, allKeys);

        return { key };
      },

      deleteSecret: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
        const result = await db
          .deleteFrom("tenant_secrets")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();

        const deleted = Number(result.numDeletedRows) > 0;

        if (deleted) {
          await openbao.deleteSecret(tenantId, key);
          const allKeys = await getAllSecretKeys(tenantId);
          await gitops.syncSecretsToGitops(tenantId, allKeys);
        }

        return deleted;
      },
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/resolvers.ts subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts
git commit -m "feat(secrets): add GraphQL resolvers with key validation"
```

---

## Task 6: Subgraph Class & Wiring

**Files:**
- Create: `subgraphs/vetra-cloud-secrets/index.ts`
- Modify: `subgraphs/index.ts`

- [ ] **Step 1: Create the subgraph class**

Create `subgraphs/vetra-cloud-secrets/index.ts`:

```typescript
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoKVClient } from "./openbao-kv.js";
import {
  syncEnvVarsToGitops,
  syncSecretsToGitops,
} from "./gitops-sync.js";

export class VetraCloudSecretsSubgraph extends BaseSubgraph {
  name = "vetra-cloud-secrets";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;

    await up(db as Kysely<any>);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    let openbao: OpenBaoKVClient | null = null;

    if (openbaoAddr) {
      openbao = new OpenBaoKVClient(openbaoAddr);
      console.info("[secrets] OpenBao KV client initialized");
    } else {
      console.warn(
        "[secrets] OPENBAO_ADDR not set — secret mutations will fail",
      );
    }

    const gitopsFns = {
      syncEnvVarsToGitops,
      syncSecretsToGitops,
    };

    this.resolvers = createResolvers(
      db,
      openbao as OpenBaoKVClient,
      gitopsFns,
    );
  }

  async onDisconnect() {
    // No long-running resources to clean up
  }
}
```

- [ ] **Step 2: Update the subgraphs index**

Add the new export to `subgraphs/index.ts`. The file currently contains:

```typescript
export * as VetraCloudObservabilitySubgraph from "./vetra-cloud-observability/index.js";
```

Add below it:

```typescript
export * as VetraCloudSecretsSubgraph from "./vetra-cloud-secrets/index.js";
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Run all subgraph tests**

Run: `npx vitest run subgraphs/vetra-cloud-secrets/`
Expected: All tests across all 4 test files PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-secrets/index.ts subgraphs/index.ts
git commit -m "feat(secrets): add VetraCloudSecretsSubgraph class and export"
```

---

## Task 7: Processor Helm Values Update

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts`

- [ ] **Step 1: Add `envFrom` to the switchboard section of `generateValuesYaml()`**

In `processors/vetra-cloud-environment/gitops.ts`, find the switchboard `env:` block (around line 326). After the `envConfigMap:` section for switchboard (after line 336), add the `envFrom` block:

Find this section:

```
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  livenessProbe:
```

In the **switchboard** section, replace with:

```
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  envFrom:
    - configMapRef:
        name: ${tenantId}-env
        optional: true
    - secretRef:
        name: ${tenantId}-secrets
        optional: true
  livenessProbe:
```

- [ ] **Step 2: Add `envFrom` to the connect section**

Find the same `envConfigMap:` / `livenessProbe:` pattern in the **connect** section (around line 394) and add the identical `envFrom` block:

```
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  envFrom:
    - configMapRef:
        name: ${tenantId}-env
        optional: true
    - secretRef:
        name: ${tenantId}-secrets
        optional: true
  livenessProbe:
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Run lint**

Run: `npm run lint:fix`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add processors/vetra-cloud-environment/gitops.ts
git commit -m "feat(secrets): add envFrom refs to Helm values for tenant ConfigMap and Secret"
```

---

## Task 8: Final Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing + new).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint:fix`
Expected: No errors or only auto-fixed issues.

- [ ] **Step 4: Verify the generated Helm values contain envFrom**

Quick manual check — run the test for the processor's gitops if one exists, or inspect the output of `generateValuesYaml()` to confirm the `envFrom` block appears under both switchboard and connect.

- [ ] **Step 5: Review git log**

Run: `git log --oneline -8`

Expected commits (newest first):
```
feat(secrets): add envFrom refs to Helm values for tenant ConfigMap and Secret
feat(secrets): add VetraCloudSecretsSubgraph class and export
feat(secrets): add GraphQL resolvers with key validation
feat(secrets): add GraphQL schema
feat(secrets): add gitops sync with ConfigMap and ExternalSecret generation
feat(secrets): add OpenBao KV v2 client
feat(secrets): add database schema and migrations
docs: add vetra-cloud-secrets subgraph design spec
```
