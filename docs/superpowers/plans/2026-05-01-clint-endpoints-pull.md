# CLINT Endpoints — Pull — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken push-announce path with a pull-based one — a 15s background worker in `vetra-cloud-observability` GETs `/clint/endpoints` from each active CLINT agent's public ingress and upserts into the existing `clint_runtime_endpoints` table.

**Architecture:** New `ClintPullWorker` class in the observability subgraph, started by the subgraph factory when `CLINT_PULL_WORKER_ENABLED=true`. URL derived per agent as `https://${prefix}.${subdomain}.vetra.io/clint/endpoints`. Replace semantics on the upsert (delete entries not in the new set, upsert those that are). Drops the `announceClintEndpoints` mutation, processor's `ensureClintAnnounceTokens`, the chart's announce env vars, and the `clint_announce_tokens` migration.

**Tech Stack:** TypeScript, Node `fetch` + `AbortController`, Kysely (Postgres upsert), Vitest with HTTP-server fixture, Helm, ArgoCD.

**Repos touched:** `vetra-cloud-package` (worker, schema/resolver/processor cleanup, migration), `powerhouse-k8s-hosting` (chart drop of announce env vars, staging tenant flag).

**Spec:** See `docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md`.

---

## File Structure

| Path (repo) | Action | Responsibility |
|---|---|---|
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/clint-pull-worker.ts` | Create | `ClintPullWorker` class — 15s tick, lists CLINT services, fetches `/clint/endpoints`, upserts |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts` | Create | Tests `tickOnce()` against a local HTTP server fixture |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/index.ts` | Modify | Wire worker into `onSetup()`, gated on `CLINT_PULL_WORKER_ENABLED=true` |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/schema.ts` | Modify | Remove `announceClintEndpoints` mutation, `ClintAnnouncementInput`, `ClintAnnouncementResult` |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/resolvers.ts` | Modify | Remove `announceClintEndpoints` resolver |
| `vetra-cloud-package/subgraphs/vetra-cloud-observability/__tests__/resolvers.test.ts` | Modify | Remove tests for the dropped mutation |
| `vetra-cloud-package/processors/vetra-cloud-environment/gitops.ts` | Modify | Remove `ensureClintAnnounceTokens`, drop `announce:` block emit in `generateClintBlock` |
| `vetra-cloud-package/processors/vetra-cloud-environment/migrations.ts` | Modify | Replace `createTable("clint_announce_tokens")` with try/catch dropTable |
| `vetra-cloud-package/processors/vetra-cloud-environment/schema.ts` | Modify | Drop `ClintAnnounceTokens` interface and the `clint_announce_tokens` field on `DB` |
| `powerhouse-k8s-hosting/powerhouse-chart/templates/clint-deployment.yaml` | Modify | Remove `{{- if and $agent.announce $agent.announce.enabled }}` block (announce env vars) |
| `powerhouse-k8s-hosting/tenants/staging/powerhouse-values.yaml` | Modify | Bump `vetra-cloud-package` version + later add `CLINT_PULL_WORKER_ENABLED: "true"` |

---

## Phase A — Worker code (TDD)

### Task A.1: Pull-worker skeleton + tests

**Working directory:** `/home/froid/projects/powerhouse/vetra-cloud-package`
**Branch:** `dev` (direct-commit per repo convention).
**Commit style:** small focused, conventional `feat(observability):`, NO `Co-Authored-By` line.
**Test runner:** `pnpm vitest run <path>`.

**Files:**
- Create: `subgraphs/vetra-cloud-observability/clint-pull-worker.ts`
- Create: `subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { ClintPullWorker } from '../clint-pull-worker.js';

type ClintEndpointsResponse = {
  endpoints: Array<{ id: string; type: string; port: string; status: string }>;
};

function startMockAgent(response: ClintEndpointsResponse | { status: number }): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ('status' in response) {
        res.statusCode = response.status;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

async function setupDbs(): Promise<{
  envDb: Kysely<any>;
  obsDb: Kysely<any>;
  insertEnv: (row: { id: string; subdomain: string; services: string }) => Promise<void>;
}> {
  const envDb = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await envDb.schema
    .createTable('environments')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('subdomain', 'text')
    .addColumn('services', 'text')
    .execute();

  const obsDb = new Kysely<any>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await obsDb.schema
    .createTable('clint_runtime_endpoints')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('documentId', 'text')
    .addColumn('prefix', 'text')
    .addColumn('endpointId', 'text')
    .addColumn('type', 'text')
    .addColumn('port', 'text')
    .addColumn('status', 'text')
    .addColumn('lastSeen', 'text')
    .execute();

  const insertEnv = async (row: { id: string; subdomain: string; services: string }) => {
    await envDb.insertInto('environments').values(row).execute();
  };

  return { envDb, obsDb, insertEnv };
}

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('ClintPullWorker.tickOnce', () => {
  let server: Server | null = null;
  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  it('upserts endpoints fetched from a CLINT agent into clint_runtime_endpoints', async () => {
    const mock = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
        { id: 'agent-mcp', type: 'api-mcp', port: '8080', status: 'enabled' },
      ],
    });
    server = mock.server;

    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });

    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: (svc) => `http://127.0.0.1:${mock.port}/clint/endpoints`,
    });

    await worker.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.endpointId).sort()).toEqual(['agent-graphql', 'agent-mcp']);
    rows.forEach((r: any) => {
      expect(r.prefix).toBe('ph-pirate-wouter');
      expect(r.lastSeen).toBeTruthy();
    });
  });

  it('removes endpoints that disappear from the agent response (replace semantics)', async () => {
    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });

    // First tick: 2 endpoints
    const mockA = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
        { id: 'agent-mcp', type: 'api-mcp', port: '8080', status: 'enabled' },
      ],
    });
    server = mockA.server;
    const worker1 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockA.port}/clint/endpoints`,
    });
    await worker1.tickOnce();
    server.close();
    server = null;

    // Second tick: only 1 endpoint
    const mockB = await startMockAgent({
      endpoints: [
        { id: 'agent-graphql', type: 'api-graphql', port: '8080', status: 'enabled' },
      ],
    });
    server = mockB.server;
    const worker2 = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mockB.port}/clint/endpoints`,
    });
    await worker2.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows.map((r: any) => r.endpointId)).toEqual(['agent-graphql']);
  });

  it('keeps existing rows untouched when the agent fetch fails (timeout/non-200)', async () => {
    const mock = await startMockAgent({ status: 503 });
    server = mock.server;

    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-1',
      subdomain: 'sure-fawn-71',
      services: JSON.stringify([
        { type: 'CLINT', enabled: true, prefix: 'ph-pirate-wouter' },
      ]),
    });
    // Pre-populate stale rows to confirm we don't clobber
    await obsDb
      .insertInto('clint_runtime_endpoints')
      .values({
        id: 'doc-1|ph-pirate-wouter|stale-id',
        documentId: 'doc-1',
        prefix: 'ph-pirate-wouter',
        endpointId: 'stale-id',
        type: 'api-graphql',
        port: '8080',
        status: 'enabled',
        lastSeen: '2026-04-30T00:00:00Z',
      })
      .execute();

    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: () => `http://127.0.0.1:${mock.port}/clint/endpoints`,
    });
    await worker.tickOnce();

    const rows = await obsDb
      .selectFrom('clint_runtime_endpoints')
      .selectAll()
      .where('documentId', '=', 'doc-1')
      .execute();
    expect(rows.map((r: any) => r.endpointId)).toEqual(['stale-id']);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/clint-pull-worker.*doc-1.*ph-pirate-wouter.*503/),
    );
  });

  it('skips envs with no enabled CLINT services', async () => {
    const { envDb, obsDb, insertEnv } = await setupDbs();
    await insertEnv({
      id: 'doc-no-clint',
      subdomain: 'no-clint',
      services: JSON.stringify([{ type: 'CONNECT', enabled: true, prefix: 'connect' }]),
    });
    await insertEnv({
      id: 'doc-disabled',
      subdomain: 'disabled',
      services: JSON.stringify([{ type: 'CLINT', enabled: false, prefix: 'ph-pirate' }]),
    });

    const fetchSpy = vi.fn();
    const worker = new ClintPullWorker({
      envDb,
      obsDb,
      logger: noopLogger,
      buildAgentUrl: (svc) => {
        fetchSpy(svc);
        return 'http://example.invalid/clint/endpoints';
      },
    });
    await worker.tickOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
pnpm vitest run subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts 2>&1 | tail -10
```

Expected: FAIL — `ClintPullWorker` module doesn't exist.

If `better-sqlite3` isn't already a devDep, the test errors with module not found. Add it before re-running:

```bash
pnpm add -D better-sqlite3
```

- [ ] **Step 3: Implement the worker**

Create `subgraphs/vetra-cloud-observability/clint-pull-worker.ts`:

```ts
import type { Kysely } from "kysely";
import type { ILogger } from "document-model";

export type ClintServiceTuple = {
  documentId: string;
  prefix: string;
  subdomain: string;
};

export type ClintPullWorkerConfig = {
  /** Processor's namespace DB — has the `environments` table. */
  envDb: Kysely<any>;
  /** Observability DB — has `clint_runtime_endpoints`. */
  obsDb: Kysely<any>;
  logger: ILogger;
  /** Defaults to 15000ms. */
  intervalMs?: number;
  /**
   * Maps a CLINT service tuple to its public `/clint/endpoints` URL.
   * Defaults to `https://${prefix}.${subdomain}.vetra.io/clint/endpoints`.
   * Overridable for tests.
   */
  buildAgentUrl?: (service: ClintServiceTuple) => string;
  /** Per-fetch timeout. Defaults to 5000ms. */
  fetchTimeoutMs?: number;
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DOMAIN = "vetra.io";

function defaultBuildAgentUrl(svc: ClintServiceTuple): string {
  return `https://${svc.prefix}.${svc.subdomain}.${DEFAULT_BASE_DOMAIN}/clint/endpoints`;
}

type ParsedService = {
  type?: string;
  enabled?: boolean;
  prefix?: string;
};

function parseClintServices(servicesJson: string | null): ParsedService[] {
  if (!servicesJson) return [];
  try {
    const parsed = JSON.parse(servicesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed as ParsedService[];
  } catch {
    return [];
  }
}

export class ClintPullWorker {
  #config: ClintPullWorkerConfig;
  #timer: NodeJS.Timeout | null = null;
  readonly #buildAgentUrl: (svc: ClintServiceTuple) => string;
  readonly #fetchTimeoutMs: number;

  constructor(config: ClintPullWorkerConfig) {
    this.#config = config;
    this.#buildAgentUrl = config.buildAgentUrl ?? defaultBuildAgentUrl;
    this.#fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  start(): void {
    if (this.#timer) return;
    const interval = this.#config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const tick = () => {
      this.tickOnce().catch((err) => {
        this.#config.logger.warn(
          `[clint-pull-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    tick();
    this.#timer = setInterval(tick, interval);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tickOnce(): Promise<void> {
    const tuples = await this.#listClintServices();
    await Promise.all(tuples.map((t) => this.#pullOne(t)));
  }

  async #listClintServices(): Promise<ClintServiceTuple[]> {
    const rows = await this.#config.envDb
      .selectFrom("environments")
      .select(["id", "subdomain", "services"])
      .execute();
    const out: ClintServiceTuple[] = [];
    for (const row of rows) {
      if (!row.subdomain) continue;
      for (const svc of parseClintServices(row.services)) {
        if (svc.type === "CLINT" && svc.enabled === true && svc.prefix) {
          out.push({ documentId: row.id, prefix: svc.prefix, subdomain: row.subdomain });
        }
      }
    }
    return out;
  }

  async #pullOne(svc: ClintServiceTuple): Promise<void> {
    const url = this.#buildAgentUrl(svc);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.#fetchTimeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) {
        this.#config.logger.warn(
          `[clint-pull-worker] ${svc.documentId} ${svc.prefix} ${res.status} from ${url}`,
        );
        return;
      }
      const body = (await res.json()) as { endpoints?: unknown };
      const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
      await this.#upsert(svc, endpoints as Array<Record<string, string>>);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#config.logger.warn(
        `[clint-pull-worker] ${svc.documentId} ${svc.prefix} fetch failed: ${reason}`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  async #upsert(
    svc: ClintServiceTuple,
    endpoints: Array<Record<string, string>>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const presented = new Set(endpoints.map((e) => e.id).filter(Boolean));

    // Delete entries no longer present.
    const existing = await this.#config.obsDb
      .selectFrom("clint_runtime_endpoints")
      .select(["id", "endpointId"])
      .where("documentId", "=", svc.documentId)
      .where("prefix", "=", svc.prefix)
      .execute();
    const toDelete = existing
      .filter((r: any) => !presented.has(r.endpointId))
      .map((r: any) => r.id);
    if (toDelete.length > 0) {
      await this.#config.obsDb
        .deleteFrom("clint_runtime_endpoints")
        .where("id", "in", toDelete)
        .execute();
    }

    // Upsert the rest. Replace `lastSeen` on every tick.
    for (const ep of endpoints) {
      if (!ep.id) continue;
      const id = `${svc.documentId}|${svc.prefix}|${ep.id}`;
      const values = {
        id,
        documentId: svc.documentId,
        prefix: svc.prefix,
        endpointId: ep.id,
        type: ep.type ?? "",
        port: ep.port ?? "",
        status: ep.status ?? "enabled",
        lastSeen: now,
      };
      // Use ON CONFLICT for upsert. SQLite + Postgres both support this.
      await this.#config.obsDb
        .insertInto("clint_runtime_endpoints")
        .values(values)
        .onConflict((oc: any) =>
          oc.column("id").doUpdateSet({
            type: values.type,
            port: values.port,
            status: values.status,
            lastSeen: values.lastSeen,
          }),
        )
        .execute();
    }
  }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
pnpm vitest run subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts 2>&1 | tail -10
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Run typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: only 4 pre-existing errors in `ph-pirate/` and `publish.config.ts`. No new errors.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-cloud-observability/clint-pull-worker.ts subgraphs/vetra-cloud-observability/__tests__/clint-pull-worker.test.ts package.json pnpm-lock.yaml
git commit -m "feat(observability): clint pull-worker — fetches /clint/endpoints, upserts runtime table"
```

(`package.json` + `pnpm-lock.yaml` only included if `pnpm add -D better-sqlite3` was needed.)

### Task A.2: Wire worker into subgraph factory

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/index.ts`

- [ ] **Step 1: Locate the place where watchers are started**

```bash
grep -n "watcherHandle\|startWatchers\|onSetup" subgraphs/vetra-cloud-observability/index.ts | head -10
```

The pull-worker should be started after the existing watchers (`startWatchers(...)` block).

- [ ] **Step 2: Add the import**

In `subgraphs/vetra-cloud-observability/index.ts` near the existing imports:

```ts
import { ClintPullWorker } from "./clint-pull-worker.js";
```

- [ ] **Step 3: Add a class field**

Inside the subgraph class declaration (alongside `watcherHandle`, `ownerBackfill`, etc.):

```ts
  private clintPullWorker: ClintPullWorker | null = null;
```

- [ ] **Step 4: Start the worker in `onSetup()` (gated on the env flag)**

Find the existing `startWatchers(...)` call. Immediately after the existing try/catch block that starts watchers, add:

```ts
    // Pull-based CLINT endpoint discovery. Replaces the legacy push announce
    // path — agents serve their endpoints at `/clint/endpoints`; we GET on a
    // 15s tick and upsert into clint_runtime_endpoints.
    if (process.env.CLINT_PULL_WORKER_ENABLED === "true") {
      try {
        this.clintPullWorker = new ClintPullWorker({
          envDb,
          obsDb: db,
          logger: this.logger,
        });
        this.clintPullWorker.start();
        console.info("[observability] ClintPullWorker started");
      } catch (err) {
        console.warn("[observability] Failed to start ClintPullWorker:", err);
      }
    }
```

- [ ] **Step 5: Stop the worker in onTeardown if it exists**

```bash
grep -n "onTeardown\|stop()" subgraphs/vetra-cloud-observability/index.ts | head -5
```

If there's an `onTeardown()` (or similar) method, add `this.clintPullWorker?.stop();` near the watcher cleanup. If no teardown exists, skip — process exit is sufficient.

- [ ] **Step 6: Typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: 4 pre-existing errors only.

- [ ] **Step 7: Commit**

```bash
git add subgraphs/vetra-cloud-observability/index.ts
git commit -m "feat(observability): wire ClintPullWorker into subgraph factory (gated)"
```

---

## Phase B — Drop the announce path

### Task B.1: Remove `announceClintEndpoints` from schema

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/schema.ts`

- [ ] **Step 1: Locate the mutation, input, result definitions**

```bash
grep -n "announceClintEndpoints\|ClintAnnouncementInput\|ClintAnnouncementResult" subgraphs/vetra-cloud-observability/schema.ts
```

Around lines 140-185, the schema has:

```graphql
"""
Receiver for clint agent endpoint announcements...
"""
announceClintEndpoints(input: ClintAnnouncementInput!): ClintAnnouncementResult!

input ClintAnnouncementInput {
  documentId: String!
  prefix: String!
  endpoints: [ClintAnnouncementEndpointInput!]!
}

input ClintAnnouncementEndpointInput {
  id: String!
  type: String!
  port: String!
  status: String
}

type ClintAnnouncementResult {
  ok: Boolean!
  count: Int!
}
```

- [ ] **Step 2: Delete those declarations**

Remove (a) the mutation field including its preceding doc-comment, (b) the `ClintAnnouncementInput` input type, (c) the `ClintAnnouncementEndpointInput` input type, (d) the `ClintAnnouncementResult` type. Keep `ClintRuntimeEndpoint` and `ClintRuntimeEndpointsForPrefix` and the `clintRuntimeEndpointsByEnv` query — those are still used by vetra.to.

After the edit, confirm:

```bash
grep -n "ClintAnnouncement\|announceClintEndpoints" subgraphs/vetra-cloud-observability/schema.ts
```

Expected: empty output.

- [ ] **Step 3: Commit**

```bash
git add subgraphs/vetra-cloud-observability/schema.ts
git commit -m "feat(observability): remove announceClintEndpoints from schema"
```

### Task B.2: Remove `announceClintEndpoints` from resolver

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/resolvers.ts`

- [ ] **Step 1: Locate the resolver and the result-type stub**

```bash
grep -n "announceClintEndpoints\|ClintAnnouncementResult" subgraphs/vetra-cloud-observability/resolvers.ts
```

You should find:
- The mutation resolver function (a long block starting around `announceClintEndpoints: async (`).
- A trailing entry in the resolver map: `ClintAnnouncementResult: {},` (around line 718).

- [ ] **Step 2: Delete both**

Remove the entire `announceClintEndpoints: async (...) => { ... },` block from the `Mutation:` map. Remove the `ClintAnnouncementResult: {}` entry from the top-level resolver map.

If any imports become unused (e.g. an `AuthAwareContext` that was only used by this resolver), TypeScript will flag it — remove the import too.

- [ ] **Step 3: Update the resolvers test**

```bash
grep -n "announceClintEndpoints\|ClintAnnouncementInput" subgraphs/vetra-cloud-observability/__tests__/resolvers.test.ts
```

Remove any test cases that exercise the announce mutation. The other tests (myEnvironments, environmentStatus, etc.) stay.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm vitest run subgraphs/vetra-cloud-observability 2>&1 | tail -10
pnpm run build:tsc 2>&1 | tail -5
```

Expected: tests pass, typecheck shows only the 4 pre-existing errors.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-cloud-observability/resolvers.ts subgraphs/vetra-cloud-observability/__tests__/resolvers.test.ts
git commit -m "feat(observability): remove announceClintEndpoints resolver"
```

### Task B.3: Drop `announce:` block from gitops + processor token mint

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts`

- [ ] **Step 1: Find the `announce:` YAML emit and the token-mint helper**

```bash
grep -n "ensureClintAnnounceTokens\|announceTokens\|announce:" processors/vetra-cloud-environment/gitops.ts | head -10
```

You'll find:
- `async function ensureClintAnnounceTokens(...)` — the legacy DB-backed mint helper.
- A call site `const announceTokens = await ensureClintAnnounceTokens(db, state, documentId);` inside `generateValuesYaml`.
- A block inside `generateClintBlock` that emits `      announce:\n        enabled: true\n        url: ...\n        documentId: ...\n        token: ...`.

- [ ] **Step 2: Delete the function**

Remove `ensureClintAnnounceTokens` entirely (the JSDoc + the function body).

- [ ] **Step 3: Delete the call site in `generateValuesYaml`**

Remove the line `const announceTokens = await ensureClintAnnounceTokens(...);`. Also remove the `announceTokens` parameter from any subsequent helper call (it was passed to `generateClintBlock`).

Update `generateClintBlock`'s signature to drop the `tokens: Record<string, string>` parameter (no consumer left).

- [ ] **Step 4: Remove the announce block from `generateClintBlock`**

Find the section that pushes lines like:

```ts
      lines.push(`      announce:`);
      lines.push(`        enabled: true`);
      lines.push(`        url: ${yamlQuote(CLINT_ANNOUNCE_URL)}`);
      lines.push(`        documentId: ${yamlQuote(documentId)}`);
      lines.push(`        token: ${yamlQuote(token)}`);
```

Delete the entire block. Also remove the `CLINT_ANNOUNCE_URL` constant if it's no longer referenced anywhere else in the file.

- [ ] **Step 5: Run gitops tests**

```bash
pnpm vitest run processors/vetra-cloud-environment/gitops.test.ts 2>&1 | tail -10
```

Tests that asserted on the announce-block YAML may need updating — remove those assertions. Tests that asserted other parts of the YAML (resources, env, ingress) should still pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: only the 4 pre-existing errors.

- [ ] **Step 7: Commit**

```bash
git add processors/vetra-cloud-environment/gitops.ts processors/vetra-cloud-environment/gitops.test.ts
git commit -m "feat(processor): drop announce-block emit and token mint from gitops"
```

### Task B.4: Drop `clint_announce_tokens` from migrations + DB type

**Files:**
- Modify: `processors/vetra-cloud-environment/migrations.ts`
- Modify: `processors/vetra-cloud-environment/schema.ts`

- [ ] **Step 1: Replace createTable with try/catch dropTable in `up()`**

In `processors/vetra-cloud-environment/migrations.ts`, find the block:

```ts
  // Bearer tokens for clint agent announcement URLs. Keyed by
  // (documentId, prefix) so a single env can host N agents, each with
  // its own token. ...
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

Replace with:

```ts
  // CLINT agents now expose endpoints via pull (see
  // docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md).
  // No tokens to mint or look up; drop the legacy table if present.
  try {
    await db.schema.dropTable("clint_announce_tokens").execute();
  } catch {
    // Table doesn't exist — fresh installs and post-drop no-ops.
  }
```

- [ ] **Step 2: Update `down()` accordingly**

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
  // this version; nothing to drop.
  await db.schema.dropTable("environments").execute();
}
```

- [ ] **Step 3: Drop the type in `schema.ts`**

In `processors/vetra-cloud-environment/schema.ts`, remove:

- The `ClintAnnounceTokens` interface (full definition + JSDoc).
- The `clint_announce_tokens: ClintAnnounceTokens;` line on the `DB` interface.

- [ ] **Step 4: Confirm no other code references the table or type**

```bash
grep -rn "clint_announce_tokens\|ClintAnnounceTokens" --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist
```

Expected: empty (or comments-only).

- [ ] **Step 5: Typecheck**

```bash
pnpm run build:tsc 2>&1 | tail -5
```

Expected: only 4 pre-existing errors.

- [ ] **Step 6: Commit**

```bash
git add processors/vetra-cloud-environment/migrations.ts processors/vetra-cloud-environment/schema.ts
git commit -m "feat(processor): drop clint_announce_tokens table and type"
```

---

## Phase C — Publish + chart cleanup

### Task C.1: Publish vetra-cloud-package

**Files:** none modified (operations).

- [ ] **Step 1: Confirm commit chain**

```bash
git log --oneline origin/dev..HEAD
```

Expected: 5–6 commits from Phase A and B (worker, factory wire, schema drop, resolver drop, gitops drop, migration drop).

- [ ] **Step 2: Push**

If `.eslintcache` shows as deleted in `git status`, stash it before pull/push:

```bash
git stash push -m "auto-stash" -- .eslintcache 2>/dev/null
git pull --rebase origin dev
git push origin dev
git stash pop 2>/dev/null
```

- [ ] **Step 3: Wait for CI publish OR fall back to local publish**

```bash
gh run list --workflow sync-and-publish.yml --limit 1 --repo powerhouse-inc/vetra-cloud-package
```

If CI publish succeeds: ✅. If E401 (recurring auth issue), fall back to local publish:

```bash
npm version prerelease --preid=dev --no-git-tag-version
NEW_VERSION=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
echo "publishing $NEW_VERSION"
npm publish --registry https://registry.dev.vetra.io --tag dev --userconfig /home/froid/.npmrc
git stash push -m "auto-stash" -- .eslintcache 2>/dev/null
git add package.json
git commit -m "chore: bump version to $NEW_VERSION [skip ci]"
git pull --rebase origin dev
git push origin dev
git stash pop 2>/dev/null
```

Verify on the registry:

```bash
curl -s 'https://registry.dev.vetra.io/@powerhousedao/vetra-cloud-package' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags'])"
```

Capture the new dev version (e.g. `0.0.3-dev.59`). It's needed in Task D.1.

### Task C.2: Drop announce env vars from chart

**Working directory:** `/home/froid/projects/powerhouse/powerhouse-k8s-hosting`
**Branch:** `main`.

**Files:**
- Modify: `powerhouse-chart/templates/clint-deployment.yaml`

- [ ] **Step 1: Locate the announce block**

```bash
grep -n "agent.announce\|SERVICE_ANNOUNCE_URL\|SERVICE_ANNOUNCE_TOKEN" powerhouse-chart/templates/clint-deployment.yaml
```

You should find a block (around lines 70-90 in the template, after `SERVICE_COMMAND`):

```yaml
        {{- if and $agent.announce $agent.announce.enabled }}
        {{- $cliName := first (splitList " " $agent.command) }}
        {{- $envPrefix := upper (replace "-" "_" $cliName) }}
        # ph-clint dev.32+ resolves serviceAnnounceUrl / serviceAnnounceToken ...
        - name: {{ printf "%s_SERVICE_ANNOUNCE_URL" $envPrefix }}
          value: {{ printf "%s?documentId=%s" $agent.announce.url $agent.announce.documentId | quote }}
        # TODO: migrate to secretKeyRef ...
        - name: {{ printf "%s_SERVICE_ANNOUNCE_TOKEN" $envPrefix }}
          value: {{ $agent.announce.token | quote }}
        {{- end }}
```

- [ ] **Step 2: Delete the block entirely**

Use Edit to remove the entire `{{- if and $agent.announce $agent.announce.enabled }}` … matching `{{- end }}`. The surrounding env vars (`SERVICE_COMMAND` above, the user-defined `$agent.env` loop below) stay.

- [ ] **Step 3: Verify chart still renders**

```bash
helm lint powerhouse-chart 2>&1 | tail -3
```

Expected: `1 chart(s) linted, 0 chart(s) failed`.

```bash
helm template test powerhouse-chart \
  --set clint.enabled=true \
  --set 'clint.agents[0].name=ph-pirate' \
  --set 'clint.agents[0].command=ph-pirate' \
  --set 'clint.agents[0].image.repository=cr.vetra.io/x/clint-runtime' \
  --set 'clint.agents[0].image.tag=dev' \
  --set 'clint.agents[0].package=@x/ph-pirate-cli' \
  --set 'clint.agents[0].version=latest' \
  --set 'clint.agents[0].registry=https://registry.dev.vetra.io' \
  --set 'clint.agents[0].announce.enabled=true' \
  --set 'clint.agents[0].announce.url=https://x' \
  --set 'clint.agents[0].announce.token=t' \
  --set 'clint.agents[0].announce.documentId=d' \
  2>&1 \
  | awk '/kind: Deployment$/,/^---$/' \
  | grep -E "ANNOUNCE|hostname:"
```

Expected: only `hostname: "ph-pirate"` (no announce env vars). If any `ANNOUNCE` lines appear, the deletion missed something.

- [ ] **Step 4: Commit**

```bash
git add powerhouse-chart/templates/clint-deployment.yaml
git commit -m "feat(chart): drop announce env vars from clint deployment

Pull-based design supersedes push announces. Agents serve runtime
endpoints at /clint/endpoints; the observability subgraph polls
that path. Chart no longer needs to inject SERVICE_ANNOUNCE_URL/TOKEN.

See vetra-cloud-package/docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md."
```

### Task C.3: Bump staging vetra-cloud-package version

**Files:**
- Modify: `tenants/staging/powerhouse-values.yaml`

- [ ] **Step 1: Identify the new version from Task C.1 step 3**

E.g. `0.0.3-dev.59`.

- [ ] **Step 2: Replace both `PH_REGISTRY_PACKAGES` lines**

```bash
grep -n "PH_REGISTRY_PACKAGES.*vetra-cloud-package" tenants/staging/powerhouse-values.yaml
```

Two occurrences (switchboard.env, connect.env) at the same version. Use Edit with `replace_all: true`:

Replace `PH_REGISTRY_PACKAGES: "@powerhousedao/vetra-cloud-package@0.0.3-dev.58"` with `PH_REGISTRY_PACKAGES: "@powerhousedao/vetra-cloud-package@<NEW_VERSION>"` (substitute the version from step 1).

- [ ] **Step 3: Commit + push (the chart change + this version bump together)**

```bash
git add tenants/staging/powerhouse-values.yaml
git commit -m "chore(staging): bump vetra-cloud-package to <NEW_VERSION>

Pulls in the pull-worker (gated off behind CLINT_PULL_WORKER_ENABLED)
plus the announce-path drop (mutation, processor token mint, table)."
git push origin main
```

ArgoCD reconciles staging → switchboard rolls. The pull-worker is wired in but inactive (flag default off). Existing CLINT pods cycle (no longer get announce env vars). Agents log `[ph-clint announce] no SERVICE_ANNOUNCE_* env vars set — skipping` (silent, no warning level).

---

## Phase D — Wait for ph-clint nginx version

This phase has **no Claude tasks**. The producer side (Prometheus's nginx-on-ph-clint) lands in the ph-clint repo, propagates to ph-pirate-cli's deps, and a new ph-pirate-cli is republished. Until that's done, agents won't serve `/clint/endpoints` and the worker (when activated) will fail every fetch with a connection error.

Operator checkpoint:

```bash
# Check the agent's exposed path manually once Prometheus's version is deployed:
curl -sS https://ph-pirate-wouter.sure-fawn-71.vetra.io/clint/endpoints | python3 -m json.tool
```

Expected: a JSON body with an `endpoints` array. If 404 or HTML, ph-clint's nginx isn't live yet — block here.

---

## Phase E — Activate the worker

### Task E.1: Trigger CLINT pod cycle so it picks up the new ph-clint

**Files:** none (operator action).

- [ ] **Step 1: Touch the env doc model for each CLINT-having env**

For each env with active CLINT services, open vetra.to → cloud → that env → rename / save (or trigger any state-changing mutation). The processor regenerates the tenant YAML; ArgoCD applies; CLINT pod cycles; agent pulls the new ph-pirate-cli (which depends on the new ph-clint with nginx).

- [ ] **Step 2: Verify each agent serves `/clint/endpoints`**

```bash
for ns in sure-fawn-71-60eb44ad sure-bear-21-30ead879; do
  echo "=== $ns ==="
  AGENT=$(kubectl -n "$ns" get pod -l app.kubernetes.io/component=clint -o jsonpath='{.items[0].spec.hostname}' 2>/dev/null)
  SUB=$(echo "$ns" | sed 's/-[a-f0-9]*$//')
  if [ -n "$AGENT" ]; then
    echo "GET https://$AGENT.$SUB.vetra.io/clint/endpoints"
    curl -sS -o /dev/null -w "%{http_code}\n" "https://$AGENT.$SUB.vetra.io/clint/endpoints" --max-time 8
  fi
done
```

Expected: `200` for every CLINT-having env. Anything else (404, 502, 000) means the agent hasn't cycled or ph-clint nginx isn't serving.

### Task E.2: Flip the feature flag on staging

**Files:**
- Modify: `tenants/staging/powerhouse-values.yaml`

- [ ] **Step 1: Add `CLINT_PULL_WORKER_ENABLED` to switchboard env**

Find the switchboard `env:` block (around line 81-105). Add the flag:

```yaml
  env:
    PORT: "3000"
    NODE_ENV: staging
    PH_REGISTRY_URL: https://registry.dev.vetra.io
    PH_REGISTRY_PACKAGES: "@powerhousedao/vetra-cloud-package@<NEW_VERSION>"
    ...
    CLINT_PULL_WORKER_ENABLED: "true"   # NEW
    ...
```

(Place it in the env block; ordering doesn't matter to k8s.)

- [ ] **Step 2: Commit + push**

```bash
git add tenants/staging/powerhouse-values.yaml
git commit -m "chore(staging): enable CLINT_PULL_WORKER_ENABLED

Activates the 15s pull-worker that GETs /clint/endpoints from each
active CLINT agent and upserts into clint_runtime_endpoints. Replaces
the broken push-announce path."
git push origin main
```

ArgoCD reconciles → switchboard pod rolls (env change → pod-template hash changes) → new pod boots with the flag set → worker starts.

### Task E.3: Validate end-to-end

**Files:** none.

- [ ] **Step 1: Confirm worker started**

```bash
NEW_POD=$(kubectl -n staging get pods -l app.kubernetes.io/component=switchboard --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}')
kubectl -n staging logs "$NEW_POD" --tail=200 2>&1 | grep -i "ClintPullWorker started" | head -3
```

Expected: one line `[observability] ClintPullWorker started`.

- [ ] **Step 2: Wait for the first tick to populate the DB (~15s)**

```bash
sleep 20
kubectl -n staging exec staging-pg-1 -c postgres -- psql -U postgres -d staging_db -t -c \
  "SELECT count(*), max(\"lastSeen\") FROM jziufckkaz.clint_runtime_endpoints;" 2>&1 | head -3
```

(The schema name `jziufckkaz` may differ — query `pg_tables` for `clint_runtime_endpoints` if needed.)

Expected: a non-zero count and a recent `lastSeen` timestamp (within the last 30 seconds).

- [ ] **Step 3: Query via GraphQL**

```bash
DOC_ID=60eb44ad-160a-4b7d-84e1-d8d076b579ac   # sure-fawn-71's documentId, adjust as needed
curl -sS -X POST https://switchboard.staging.vetra.io/graphql \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"{ clintRuntimeEndpointsByEnv(documentId: \\\"$DOC_ID\\\") { prefix endpoints { id type port status } } }\"}" \
  --max-time 10 | python3 -m json.tool
```

Expected: `data.clintRuntimeEndpointsByEnv` is non-empty, with one entry per active CLINT prefix and an `endpoints` array under each.

- [ ] **Step 4: Confirm in vetra.to UI**

Open `https://staging.vetra.io/cloud/<env-doc-id>` → expand the agent card → "Endpoints" panel populates within ~15s.

- [ ] **Step 5: Worker resilience smoke**

Pick one CLINT pod and `kubectl delete pod` to force a recycle. The pod re-starts, comes back up, the next worker tick fetches its endpoints. Existing rows in `clint_runtime_endpoints` are NOT cleared during the brief outage (verified by the worker's "keep existing rows on fetch failure" semantics from Task A.1).

If validation fails on Step 1-4, common causes:
- Worker not started → check `CLINT_PULL_WORKER_ENABLED` env on the pod (`kubectl ... get pod ... -o jsonpath`).
- Worker started but DB empty → check logs for `[clint-pull-worker]` warn lines (URL build, fetch errors).
- `clintRuntimeEndpointsByEnv` returns empty → check that the `clint_runtime_endpoints` table is the same one the resolver reads (schema-namespace match — see the prior post-mortem about cross-component schema isolation; the worker writes to `obsDb` which is the resolver's `db`, so this should match by construction).

---

## Phase F — Cleanup

### Task F.1: Remove feature flag

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/index.ts`
- Modify: `tenants/staging/powerhouse-values.yaml`

After at least one full day of stable operation in staging:

- [ ] **Step 1: Remove the flag check from `index.ts`**

In `subgraphs/vetra-cloud-observability/index.ts`, find:

```ts
    if (process.env.CLINT_PULL_WORKER_ENABLED === "true") {
      try {
        this.clintPullWorker = new ClintPullWorker({...});
        this.clintPullWorker.start();
        console.info("[observability] ClintPullWorker started");
      } catch (err) {
        console.warn("[observability] Failed to start ClintPullWorker:", err);
      }
    }
```

Remove the outer `if (process.env...)` so the worker always starts:

```ts
    try {
      this.clintPullWorker = new ClintPullWorker({...});
      this.clintPullWorker.start();
      console.info("[observability] ClintPullWorker started");
    } catch (err) {
      console.warn("[observability] Failed to start ClintPullWorker:", err);
    }
```

- [ ] **Step 2: Remove `CLINT_PULL_WORKER_ENABLED` from staging values**

```bash
grep -n "CLINT_PULL_WORKER_ENABLED" tenants/staging/powerhouse-values.yaml
```

Delete the line.

- [ ] **Step 3: Commit each repo**

In `vetra-cloud-package`:

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
git add subgraphs/vetra-cloud-observability/index.ts
git commit -m "feat(observability): remove CLINT_PULL_WORKER_ENABLED gate (now always-on)"
git push origin dev
```

Republish per Task C.1 step 3 (CI or local).

In `powerhouse-k8s-hosting`:

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-hosting
git add tenants/staging/powerhouse-values.yaml
git commit -m "chore(staging): drop CLINT_PULL_WORKER_ENABLED gate (now always-on)

After bumping vetra-cloud-package to the version that drops the
feature-flag, this var is no longer read."
git push origin main
```

(Bump staging's `PH_REGISTRY_PACKAGES` to the new version too if needed.)

### Task F.2: Mark spec Shipped

**Files:**
- Modify: `vetra-cloud-package/docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md`

- [ ] **Step 1: Flip status header**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
sed -i 's/^\*\*Status:\*\* Draft/**Status:** Shipped/' docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md
grep '^\*\*Status:' docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md
```

Expected: `**Status:** Shipped`.

- [ ] **Step 2: Commit + push**

```bash
git add docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md
git commit -m "docs(observability): mark clint-endpoints-pull spec as Shipped"
git push origin dev
```
