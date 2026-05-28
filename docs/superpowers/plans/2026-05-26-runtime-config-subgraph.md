# Runtime Config Subgraph — Vetra Cloud Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `vetra-cloud-runtime-config` subgraph (Query `runtimeConfig`, Mutation `setRuntimeConfig`) per the companion design spec (`docs/superpowers/specs/2026-05-26-runtime-config-subgraph-design.md`), with TDD coverage and a clean build.

**Architecture:** A new subgraph under `subgraphs/vetra-cloud-runtime-config/`. Extends `BaseSubgraph` from `@powerhousedao/reactor-api`. Validates inputs against `runtimeConfigSchema` from `@powerhousedao/builder-tools` via Ajv. Merges overrides on top of `DEFAULT_CONNECT_CONFIG` from `@powerhousedao/shared/connect`. Persists a single `PH_CONNECT_CONFIG_JSON` row per tenant via a small `EnvVarsStore` port (Kysely-backed in production, in-memory for tests).

**Tech Stack:** TypeScript, vitest, kysely (already deps), `@electric-sql/pglite` (already devDep) for integration tests, `ajv` (new dep), `graphql` + `graphql-tag` (already deps).

---

## File Structure

**Created:**
- `subgraphs/vetra-cloud-runtime-config/index.ts`
- `subgraphs/vetra-cloud-runtime-config/subgraph.ts`
- `subgraphs/vetra-cloud-runtime-config/schema.ts`
- `subgraphs/vetra-cloud-runtime-config/resolvers.ts`
- `subgraphs/vetra-cloud-runtime-config/store.ts`
- `subgraphs/vetra-cloud-runtime-config/defaults.ts`
- `subgraphs/vetra-cloud-runtime-config/validation.ts`
- `subgraphs/vetra-cloud-runtime-config/errors.ts`
- `subgraphs/vetra-cloud-runtime-config/auth.ts`
- `subgraphs/vetra-cloud-runtime-config/types.ts`
- `subgraphs/vetra-cloud-runtime-config/__tests__/defaults.test.ts`
- `subgraphs/vetra-cloud-runtime-config/__tests__/validation.test.ts`
- `subgraphs/vetra-cloud-runtime-config/__tests__/store.test.ts`
- `subgraphs/vetra-cloud-runtime-config/__tests__/resolvers.test.ts`

**Modified:**
- `subgraphs/index.ts` — re-export the new subgraph class.
- `package.json` — add `ajv` (^8) to `dependencies`.

**Not modified:** any other source file in the package.

---

## Task 1: Install `ajv` dependency

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add Ajv as a dependency.**

```bash
pnpm add ajv@^8
```

Expected: `ajv` appears under `dependencies` in `package.json`; lockfile updated.

- [ ] **Step 2: Verify install.**

```bash
node -e "console.log(require('ajv/package.json').version)"
```

Expected: prints an 8.x version.

---

## Task 2: Types module

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/types.ts`

- [ ] **Step 1: Write the module.**

```ts
import type { PHConnectRuntimeConfig } from "@powerhousedao/shared/connect";

export type RuntimeConfigOverrides = Partial<{
  connect: Partial<PHConnectRuntimeConfig>;
  schemaVersion: number;
  packages: unknown[];
  packageRegistryUrl: string;
  localPackage: unknown;
}>;

export type RuntimeConfigEffective = {
  schemaVersion: number;
  packages: unknown[];
  localPackage: unknown;
  packageRegistryUrl?: string;
  connect: PHConnectRuntimeConfig;
};

export type RuntimeConfigPayload = {
  effective: RuntimeConfigEffective;
  overrides: RuntimeConfigOverrides;
  schemaVersion: string;
  updatedAt: string | null;
};

export type EnvVarsStore = {
  getRuntimeConfigOverrides(tenantId: string): Promise<{
    value: string;
    updatedAt: Date;
  } | null>;
  setRuntimeConfigOverrides(
    tenantId: string,
    value: string | null,
  ): Promise<{ updatedAt: Date | null }>;
};

export const RUNTIME_CONFIG_ENV_KEY = "PH_CONNECT_CONFIG_JSON";
export const RUNTIME_CONFIG_SCHEMA_VERSION = "2";
```

- [ ] **Step 2: Compile-check.**

```bash
pnpm tsc --noEmit
```

Expected: passes (file is types-only; nothing depends on it yet, but it must typecheck).

---

## Task 3: Errors module

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/errors.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import { InvalidRuntimeConfigError } from "../errors.js";

describe("InvalidRuntimeConfigError", () => {
  it("exposes issues via GraphQL extensions and stringifies them in the message", () => {
    const err = new InvalidRuntimeConfigError([
      { path: "/connect/app/logLevel", message: "must be string" },
      { path: "/connect/branding", message: "must NOT have additional property 'foo'" },
    ]);
    expect(err.extensions).toMatchObject({ code: "INVALID_RUNTIME_CONFIG" });
    expect((err.extensions as { issues: unknown }).issues).toHaveLength(2);
    expect(err.message).toContain("/connect/app/logLevel");
    expect(err.message).toContain("must NOT have additional property");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

```bash
pnpm test -- errors
```

Expected: FAIL with "Cannot find module '../errors.js'" or similar.

- [ ] **Step 3: Write the implementation.**

```ts
import { GraphQLError } from "graphql";

export type RuntimeConfigIssue = { path: string; message: string };

export class InvalidRuntimeConfigError extends GraphQLError {
  constructor(public readonly issues: RuntimeConfigIssue[]) {
    super(
      `Invalid runtime config: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
      {
        extensions: {
          code: "INVALID_RUNTIME_CONFIG",
          issues,
        },
      },
    );
  }
}
```

- [ ] **Step 4: Run to verify pass.**

```bash
pnpm test -- errors
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/errors.ts subgraphs/vetra-cloud-runtime-config/__tests__/errors.test.ts
git commit -m "feat(runtime-config): add InvalidRuntimeConfigError"
```

---

## Task 4: Defaults merge

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/defaults.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/__tests__/defaults.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { mergeWithDefaults } from "../defaults.js";
import { DEFAULT_CONNECT_CONFIG } from "@powerhousedao/shared/connect";

describe("mergeWithDefaults", () => {
  it("returns a populated effective config when overrides are empty", () => {
    const effective = mergeWithDefaults({});
    expect(effective.connect).toEqual(DEFAULT_CONNECT_CONFIG);
  });

  it("replaces only touched keys, leaving siblings as defaults", () => {
    const effective = mergeWithDefaults({
      connect: { branding: { appName: "Acme Connect" } },
    });
    expect(effective.connect.branding.appName).toBe("Acme Connect");
    // sibling default preserved
    expect(effective.connect.app.logLevel).toBe(
      DEFAULT_CONNECT_CONFIG.app.logLevel,
    );
  });

  it("nested merge: deep object overrides only the explicit leaves", () => {
    const effective = mergeWithDefaults({
      connect: { drives: { sections: { remote: { allowAdd: false } } } },
    });
    expect(effective.connect.drives.sections.remote.allowAdd).toBe(false);
    // sibling leaves of remote stay default
    expect(effective.connect.drives.sections.remote.enabled).toBe(true);
    expect(effective.connect.drives.sections.remote.allowDelete).toBe(true);
    // sibling section (local) stays default
    expect(effective.connect.drives.sections.local).toEqual(
      DEFAULT_CONNECT_CONFIG.drives.sections.local,
    );
  });

  it("array overrides replace wholesale (no element merge)", () => {
    const drives = [
      { url: "https://a.example", name: null, icon: null },
      { url: "https://b.example", name: null, icon: null },
    ];
    const effective = mergeWithDefaults({ connect: { drives: { defaultDrives: drives } } });
    expect(effective.connect.drives.defaultDrives).toEqual(drives);
  });

  it("null override replaces a non-null default (sentry.dsn off-switch)", () => {
    const effective = mergeWithDefaults({ connect: { sentry: { dsn: null } } });
    expect(effective.connect.sentry.dsn).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

```bash
pnpm test -- defaults
```

Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation.**

```ts
import { DEFAULT_CONNECT_CONFIG } from "@powerhousedao/shared/connect";
import type {
  RuntimeConfigEffective,
  RuntimeConfigOverrides,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) {
    // null, primitives, arrays: override wins.
    return override as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = deepMerge(
      (base as Record<string, unknown>)[key],
      (override as Record<string, unknown>)[key],
    );
  }
  return result as T;
}

export function mergeWithDefaults(
  overrides: RuntimeConfigOverrides,
): RuntimeConfigEffective {
  const connect = deepMerge(DEFAULT_CONNECT_CONFIG, overrides.connect);
  return {
    schemaVersion: overrides.schemaVersion ?? 2,
    packages: overrides.packages ?? [],
    localPackage: overrides.localPackage ?? null,
    packageRegistryUrl: overrides.packageRegistryUrl,
    connect,
  };
}
```

- [ ] **Step 4: Run to verify pass.**

```bash
pnpm test -- defaults
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/types.ts subgraphs/vetra-cloud-runtime-config/defaults.ts subgraphs/vetra-cloud-runtime-config/__tests__/defaults.test.ts
git commit -m "feat(runtime-config): add defaults merge"
```

---

## Task 5: Validation

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/validation.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/__tests__/validation.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "../validation.js";

describe("validateRuntimeConfig", () => {
  it("accepts an empty override", () => {
    expect(validateRuntimeConfig({}).ok).toBe(true);
  });

  it("accepts a partial connect.* override matching the schema", () => {
    expect(
      validateRuntimeConfig({
        connect: { branding: { appName: "Acme" } },
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown top-level properties with structured issues", () => {
    const result = validateRuntimeConfig({ notAConfig: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.message.includes("additional"))).toBe(
        true,
      );
    }
  });

  it("rejects wrong-type fields with a path pointing at them", () => {
    const result = validateRuntimeConfig({
      connect: { app: { logLevel: 123 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.includes("logLevel"))).toBe(
        true,
      );
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.**

```bash
pnpm test -- validation
```

Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation.**

```ts
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { runtimeConfigSchema } from "@powerhousedao/builder-tools";
import type { RuntimeConfigIssue } from "./errors.js";

// The published schema requires `schemaVersion`, `packages`, `localPackage` at
// the top level — those are emitter-stamped fields the operator never sets.
// For the subgraph's override JSON we want to accept partial input, so we
// validate against a schema with `required` cleared at the top level.
const overrideSchema = (() => {
  const cloned = JSON.parse(JSON.stringify(runtimeConfigSchema)) as Record<
    string,
    unknown
  > & { required?: string[] };
  delete cloned.required;
  return cloned;
})();

const ajv = new Ajv.default({ allErrors: true, strict: false });
const validate: ValidateFunction = ajv.compile(overrideSchema);

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: RuntimeConfigIssue[] };

export function validateRuntimeConfig(json: unknown): ValidationResult {
  const passed = validate(json);
  if (passed) return { ok: true };
  const issues: RuntimeConfigIssue[] = (validate.errors ?? []).map(
    (e: ErrorObject) => ({
      path: e.instancePath || "/",
      message: `${e.message ?? "invalid"}${
        e.params ? ` (${JSON.stringify(e.params)})` : ""
      }`,
    }),
  );
  return { ok: false, issues };
}
```

- [ ] **Step 4: Run to verify pass.**

```bash
pnpm test -- validation
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/validation.ts subgraphs/vetra-cloud-runtime-config/__tests__/validation.test.ts
git commit -m "feat(runtime-config): add ajv validation against runtimeConfigSchema"
```

---

## Task 6: EnvVarsStore (in-memory + Kysely)

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/store.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import {
  InMemoryEnvVarsStore,
  KyselyEnvVarsStore,
} from "../store.js";

describe("InMemoryEnvVarsStore", () => {
  it("returns null when nothing is stored", async () => {
    const s = new InMemoryEnvVarsStore();
    expect(await s.getRuntimeConfigOverrides("t1")).toBeNull();
  });

  it("round-trips a value with updatedAt", async () => {
    const s = new InMemoryEnvVarsStore();
    const { updatedAt } = await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    expect(updatedAt).toBeInstanceOf(Date);
    const row = await s.getRuntimeConfigOverrides("t1");
    expect(row).not.toBeNull();
    expect(row!.value).toBe('{"a":1}');
  });

  it("set(null) deletes the row", async () => {
    const s = new InMemoryEnvVarsStore();
    await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    await s.setRuntimeConfigOverrides("t1", null);
    expect(await s.getRuntimeConfigOverrides("t1")).toBeNull();
  });

  it("isolates tenants", async () => {
    const s = new InMemoryEnvVarsStore();
    await s.setRuntimeConfigOverrides("t1", '{"a":1}');
    expect(await s.getRuntimeConfigOverrides("t2")).toBeNull();
  });
});

// pglite-backed integration. Confirms the SQL the Kysely store emits actually
// round-trips on a real Postgres dialect.
describe("KyselyEnvVarsStore (pglite)", () => {
  it("creates the table on first use and round-trips a value", async () => {
    const pg = new PGlite();
    const db = new Kysely<any>({
      dialect: {
        // minimal dialect adapter for pglite
        createAdapter: () =>
          ({
            supportsCreateIfNotExists: true,
            supportsTransactionalDdl: true,
            supportsReturning: true,
            acquireMigrationLock: async () => {},
            releaseMigrationLock: async () => {},
          }) as any,
        createDriver: () =>
          ({
            init: async () => {},
            acquireConnection: async () =>
              ({
                executeQuery: async (q: any) => {
                  const r = await pg.query(q.sql, q.parameters as any[]);
                  return { rows: r.rows as any[] };
                },
                streamQuery: async function* () {},
              }) as any,
            beginTransaction: async () => {},
            commitTransaction: async () => {},
            rollbackTransaction: async () => {},
            releaseConnection: async () => {},
            destroy: async () => {},
          }) as any,
        createIntrospector: () => ({}) as any,
        createQueryCompiler: () => {
          const { PostgresQueryCompiler } = require("kysely");
          return new PostgresQueryCompiler();
        },
      } as any,
    });

    const store = new KyselyEnvVarsStore(db);
    await store.ensureSchema();

    expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();
    const { updatedAt } = await store.setRuntimeConfigOverrides("t1", '{"a":1}');
    expect(updatedAt).toBeInstanceOf(Date);

    const row = await store.getRuntimeConfigOverrides("t1");
    expect(row?.value).toBe('{"a":1}');

    await store.setRuntimeConfigOverrides("t1", null);
    expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();

    await pg.close();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

```bash
pnpm test -- store
```

Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation.**

```ts
import { type Kysely, sql } from "kysely";
import { RUNTIME_CONFIG_ENV_KEY, type EnvVarsStore } from "./types.js";

type EnvVarRow = {
  tenant_id: string;
  key: string;
  value: string;
  updated_at: Date;
};

type EnvVarsTable = { env_vars: EnvVarRow };

export class InMemoryEnvVarsStore implements EnvVarsStore {
  private rows = new Map<string, { value: string; updatedAt: Date }>();

  async getRuntimeConfigOverrides(tenantId: string) {
    const row = this.rows.get(tenantId);
    return row ? { ...row } : null;
  }

  async setRuntimeConfigOverrides(tenantId: string, value: string | null) {
    if (value === null) {
      this.rows.delete(tenantId);
      return { updatedAt: null };
    }
    const updatedAt = new Date();
    this.rows.set(tenantId, { value, updatedAt });
    return { updatedAt };
  }
}

export class KyselyEnvVarsStore implements EnvVarsStore {
  constructor(
    private readonly db: Kysely<EnvVarsTable>,
    private readonly tableName: string = "env_vars",
    private readonly notifyChannel: string = "env_vars_changed",
  ) {}

  /** Idempotent schema setup for environments that don't have the table yet (tests, dev). */
  async ensureSchema(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.ref(this.tableName)} (
        tenant_id  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, key)
      )
    `.execute(this.db);
  }

  async getRuntimeConfigOverrides(tenantId: string) {
    const row = await this.db
      .selectFrom(this.tableName as "env_vars")
      .select(["value", "updated_at"])
      .where("tenant_id", "=", tenantId)
      .where("key", "=", RUNTIME_CONFIG_ENV_KEY)
      .executeTakeFirst();
    if (!row) return null;
    return { value: row.value, updatedAt: new Date(row.updated_at) };
  }

  async setRuntimeConfigOverrides(tenantId: string, value: string | null) {
    if (value === null) {
      await this.db
        .deleteFrom(this.tableName as "env_vars")
        .where("tenant_id", "=", tenantId)
        .where("key", "=", RUNTIME_CONFIG_ENV_KEY)
        .execute();
      await this.notify(tenantId);
      return { updatedAt: null };
    }

    const inserted = await this.db
      .insertInto(this.tableName as "env_vars")
      .values({
        tenant_id: tenantId,
        key: RUNTIME_CONFIG_ENV_KEY,
        value,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "key"]).doUpdateSet({
          value: (eb) => eb.ref("excluded.value"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      )
      .returning("updated_at")
      .executeTakeFirstOrThrow();
    await this.notify(tenantId);
    return { updatedAt: new Date(inserted.updated_at) };
  }

  private async notify(tenantId: string): Promise<void> {
    try {
      await sql`SELECT pg_notify(${this.notifyChannel}, ${tenantId})`.execute(
        this.db,
      );
    } catch {
      // pg_notify failure should not abort the write; the secrets-controller
      // also polls. Production logging hooks can be wired by the deployment.
    }
  }
}
```

- [ ] **Step 4: Run to verify pass.**

```bash
pnpm test -- store
```

Expected: PASS. If the pglite test fails because of dialect compatibility, simplify the pglite test to use raw `pg.query` calls and a thin `EnvVarsStore` implementation wrapping `pg` directly, OR mark the pglite test `.skip` and rely on the in-memory tests plus production validation. Document the choice in the file's top comment.

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/store.ts subgraphs/vetra-cloud-runtime-config/__tests__/store.test.ts
git commit -m "feat(runtime-config): add EnvVarsStore (in-memory + kysely)"
```

---

## Task 7: Auth guard

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/auth.ts`

- [ ] **Step 1: Write the module.**

```ts
import { GraphQLError } from "graphql";

export type AuthContext = { user?: { address?: string | null } };

export function requireAuthenticatedUser(ctx: AuthContext): {
  address: string;
} {
  const address = ctx.user?.address;
  if (!address) {
    throw new GraphQLError("Unauthenticated", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return { address };
}
```

- [ ] **Step 2: Compile-check.**

```bash
pnpm tsc --noEmit
```

Expected: passes.

---

## Task 8: Resolvers (with in-memory store tests)

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/resolvers.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/__tests__/resolvers.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_CONFIG } from "@powerhousedao/shared/connect";
import { createResolvers } from "../resolvers.js";
import { InMemoryEnvVarsStore } from "../store.js";
import { InvalidRuntimeConfigError } from "../errors.js";

const authedCtx = { user: { address: "0x1234" } };

function setup() {
  const store = new InMemoryEnvVarsStore();
  const resolvers = createResolvers({ store });
  return { store, resolvers };
}

describe("runtimeConfig (Query)", () => {
  it("returns defaults + empty overrides when nothing stored", async () => {
    const { resolvers } = setup();
    const payload = await resolvers.Query.runtimeConfig(
      null,
      { tenantId: "t1" },
      authedCtx,
    );
    expect(payload.overrides).toEqual({});
    expect(payload.effective.connect).toEqual(DEFAULT_CONNECT_CONFIG);
    expect(payload.updatedAt).toBeNull();
    expect(payload.schemaVersion).toBe("2");
  });

  it("merges stored overrides on top of defaults", async () => {
    const { store, resolvers } = setup();
    await store.setRuntimeConfigOverrides(
      "t1",
      JSON.stringify({ connect: { branding: { appName: "Acme" } } }),
    );
    const payload = await resolvers.Query.runtimeConfig(
      null,
      { tenantId: "t1" },
      authedCtx,
    );
    expect(payload.effective.connect.branding.appName).toBe("Acme");
    expect(payload.overrides).toEqual({
      connect: { branding: { appName: "Acme" } },
    });
    expect(payload.updatedAt).not.toBeNull();
  });

  it("throws Unauthenticated when ctx.user is missing", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Query.runtimeConfig(null, { tenantId: "t1" }, {}),
    ).rejects.toThrow(/Unauthenticated/);
  });
});

describe("setRuntimeConfig (Mutation)", () => {
  it("rejects invalid JSON with InvalidRuntimeConfigError", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Mutation.setRuntimeConfig(
        null,
        { tenantId: "t1", json: { connect: { app: { logLevel: 123 } } } },
        authedCtx,
      ),
    ).rejects.toThrow(InvalidRuntimeConfigError);
  });

  it("persists valid JSON and returns the new effective", async () => {
    const { store, resolvers } = setup();
    const payload = await resolvers.Mutation.setRuntimeConfig(
      null,
      {
        tenantId: "t1",
        json: { connect: { branding: { appName: "Acme" } } },
      },
      authedCtx,
    );
    expect(payload.effective.connect.branding.appName).toBe("Acme");
    const row = await store.getRuntimeConfigOverrides("t1");
    expect(row?.value).toContain("Acme");
  });

  it("empty object deletes the row (revert to defaults)", async () => {
    const { store, resolvers } = setup();
    await store.setRuntimeConfigOverrides(
      "t1",
      JSON.stringify({ connect: { branding: { appName: "Acme" } } }),
    );
    const payload = await resolvers.Mutation.setRuntimeConfig(
      null,
      { tenantId: "t1", json: {} },
      authedCtx,
    );
    expect(await store.getRuntimeConfigOverrides("t1")).toBeNull();
    expect(payload.effective.connect).toEqual(DEFAULT_CONNECT_CONFIG);
  });

  it("throws Unauthenticated when ctx.user is missing", async () => {
    const { resolvers } = setup();
    await expect(
      resolvers.Mutation.setRuntimeConfig(
        null,
        { tenantId: "t1", json: {} },
        {},
      ),
    ).rejects.toThrow(/Unauthenticated/);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

```bash
pnpm test -- resolvers
```

Expected: FAIL (resolvers module missing).

- [ ] **Step 3: Write the implementation.**

```ts
import { mergeWithDefaults } from "./defaults.js";
import { InvalidRuntimeConfigError } from "./errors.js";
import { requireAuthenticatedUser, type AuthContext } from "./auth.js";
import { validateRuntimeConfig } from "./validation.js";
import {
  RUNTIME_CONFIG_SCHEMA_VERSION,
  type EnvVarsStore,
  type RuntimeConfigOverrides,
  type RuntimeConfigPayload,
} from "./types.js";

export type ResolversDeps = { store: EnvVarsStore };

export function createResolvers(deps: ResolversDeps) {
  const { store } = deps;

  async function query(
    _parent: unknown,
    args: { tenantId: string },
    ctx: AuthContext,
  ): Promise<RuntimeConfigPayload> {
    requireAuthenticatedUser(ctx);
    const row = await store.getRuntimeConfigOverrides(args.tenantId);
    const overrides = parseOverrides(row?.value);
    return {
      effective: mergeWithDefaults(overrides),
      overrides,
      schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async function mutation(
    _parent: unknown,
    args: { tenantId: string; json: unknown },
    ctx: AuthContext,
  ): Promise<RuntimeConfigPayload> {
    requireAuthenticatedUser(ctx);
    const validation = validateRuntimeConfig(args.json);
    if (!validation.ok) {
      throw new InvalidRuntimeConfigError(validation.issues);
    }
    const overrides = (args.json ?? {}) as RuntimeConfigOverrides;
    const isEmpty = Object.keys(overrides).length === 0;
    const { updatedAt } = await store.setRuntimeConfigOverrides(
      args.tenantId,
      isEmpty ? null : JSON.stringify(overrides),
    );
    return {
      effective: mergeWithDefaults(overrides),
      overrides,
      schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  return {
    Query: { runtimeConfig: query },
    Mutation: { setRuntimeConfig: mutation },
  };
}

function parseOverrides(value: string | undefined): RuntimeConfigOverrides {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as RuntimeConfigOverrides;
    }
  } catch {
    // Stored value corrupt; treat as no overrides rather than throwing on
    // every read.
  }
  return {};
}
```

- [ ] **Step 4: Run to verify pass.**

```bash
pnpm test -- resolvers
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/auth.ts subgraphs/vetra-cloud-runtime-config/resolvers.ts subgraphs/vetra-cloud-runtime-config/__tests__/resolvers.test.ts
git commit -m "feat(runtime-config): add resolver pair backed by EnvVarsStore"
```

---

## Task 9: GraphQL SDL + subgraph class

**Files:**
- Create: `subgraphs/vetra-cloud-runtime-config/schema.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/subgraph.ts`
- Create: `subgraphs/vetra-cloud-runtime-config/index.ts`

- [ ] **Step 1: Write `schema.ts`.**

```ts
import { gql } from "graphql-tag";

export const typeDefs = gql`
  scalar JSON

  type RuntimeConfigPayload {
    effective: JSON!
    overrides: JSON!
    schemaVersion: String!
    updatedAt: String
  }

  extend type Query {
    runtimeConfig(tenantId: String!): RuntimeConfigPayload!
  }

  extend type Mutation {
    setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload!
  }
`;
```

- [ ] **Step 2: Write `subgraph.ts`.**

```ts
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { SubgraphArgs } from "@powerhousedao/reactor-api";
import { createResolvers } from "./resolvers.js";
import { KyselyEnvVarsStore } from "./store.js";
import { typeDefs } from "./schema.js";
import type { EnvVarsStore } from "./types.js";

export type VetraCloudRuntimeConfigOptions = {
  /**
   * Override the storage backend. Defaults to a `KyselyEnvVarsStore` wired up
   * to the `relationalDb` exposed by BaseSubgraph. Tests and alternative
   * deployments can pass an in-memory or custom implementation here.
   */
  store?: EnvVarsStore;
};

export class VetraCloudRuntimeConfigSubgraph extends BaseSubgraph {
  name = "vetra-cloud-runtime-config";
  hasSubscriptions = false;
  typeDefs = typeDefs;
  resolvers: Record<string, unknown>;

  constructor(args: SubgraphArgs, options: VetraCloudRuntimeConfigOptions = {}) {
    super(args);
    const store =
      options.store ??
      new KyselyEnvVarsStore(this.relationalDb as Kysely<EnvVarsTable>);
    this.resolvers = createResolvers({ store });
  }
}
```

- [ ] **Step 3: Write `index.ts`.**

```ts
export { VetraCloudRuntimeConfigSubgraph } from "./subgraph.js";
export type { VetraCloudRuntimeConfigOptions } from "./subgraph.js";
export {
  InMemoryEnvVarsStore,
  KyselyEnvVarsStore,
} from "./store.js";
export type { EnvVarsStore } from "./types.js";
```

- [ ] **Step 4: Compile-check.**

```bash
pnpm tsc --noEmit
```

Expected: passes. If `relationalDb` typing doesn't fit `Kysely<EnvVarsTable>`, refine the cast or add a structural adapter.

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-runtime-config/schema.ts subgraphs/vetra-cloud-runtime-config/subgraph.ts subgraphs/vetra-cloud-runtime-config/index.ts
git commit -m "feat(runtime-config): add subgraph class + SDL"
```

---

## Task 10: Wire into package barrel

**Files:**
- Modify: `subgraphs/index.ts`

- [ ] **Step 1: Replace `export {};` with the new subgraph re-export.**

```ts
export * from "./vetra-cloud-runtime-config/index.js";
```

- [ ] **Step 2: Compile + lint.**

```bash
pnpm tsc --noEmit
pnpm lint -- subgraphs
```

Expected: both pass.

- [ ] **Step 3: Commit.**

```bash
git add subgraphs/index.ts
git commit -m "feat(runtime-config): re-export subgraph from package barrel"
```

---

## Task 11: Verify build + full test suite

- [ ] **Step 1: Full test run.**

```bash
pnpm test
```

Expected: all green; the new test files contribute 5 + 4 + (4 in-memory + 1 pglite) + 6 + 1 = 20 tests minimum.

- [ ] **Step 2: TypeScript build.**

```bash
pnpm build:tsc
```

Expected: clean exit (`dist/` populated; the package's own `tsc` build).

- [ ] **Step 3: Lint.**

```bash
pnpm lint
```

Expected: no errors (warnings tolerated if pre-existing in the repo).

- [ ] **Step 4: Document any test-skips or environmental constraints in the spec's "Open at integration time" section if the pglite store test had to be skipped.**

---

## Verification gate

- [ ] All tests pass.
- [ ] Build is green.
- [ ] Lint is green.
- [ ] No edits outside `subgraphs/vetra-cloud-runtime-config/`, `subgraphs/index.ts`, and `package.json`.
- [ ] Branch is `feat/runtime-config-subgraph`.

Once verified, the cross-repo master plan §10 (rollout) can proceed: open PRs, bump versions, validate in `dev`.
