import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { RuntimeConfigDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "../bundled-defaults.js";
import { RUNTIME_CONFIG_SCHEMA_VERSION } from "../types.js";

let db: Kysely<RuntimeConfigDB>;
let resolvers: ReturnType<typeof createResolvers>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<RuntimeConfigDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
  resolvers = createResolvers(db);
});

afterEach(async () => {
  await db.destroy();
});

const query = () => resolvers.Query;
const mutation = () => resolvers.Mutation;

describe("Query.runtimeConfig", () => {
  it("returns defaults + empty overrides for unknown tenant", async () => {
    const result = await query().runtimeConfig(undefined, {
      tenantId: "unknown",
    });
    expect(result.overrides).toEqual({});
    expect(result.effective).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
    expect(result.updatedAt).toBeNull();
    expect(result.schemaVersion).toBe(RUNTIME_CONFIG_SCHEMA_VERSION);
  });

  it("returns merged defaults+overrides when row exists", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "t1",
        value: JSON.stringify({ branding: { appName: "Acme" } }),
        updatedAt: "2026-05-28T12:00:00Z",
      })
      .execute();

    const result = await query().runtimeConfig(undefined, {
      tenantId: "t1",
    });
    expect(result.overrides).toEqual({
      branding: { appName: "Acme" },
    });
    expect(result.effective.branding?.appName).toBe("Acme");
    // Other defaults still merged in.
    expect(result.effective.app?.logLevel).toBe("info");
    expect(result.updatedAt).toBe("2026-05-28T12:00:00Z");
  });

  it("treats corrupt stored value as empty overrides (no throw)", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "t1",
        value: "not-json",
        updatedAt: "2026-05-28T12:00:00Z",
      })
      .execute();

    const result = await query().runtimeConfig(undefined, {
      tenantId: "t1",
    });
    expect(result.overrides).toEqual({});
    expect(result.effective).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
  });

  it("treats stored array as empty overrides (object guard)", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "t1",
        value: JSON.stringify([1, 2, 3]),
        updatedAt: "2026-05-28T12:00:00Z",
      })
      .execute();

    const result = await query().runtimeConfig(undefined, {
      tenantId: "t1",
    });
    expect(result.overrides).toEqual({});
  });
});

describe("Mutation.setRuntimeConfig", () => {
  it("inserts a new override row", async () => {
    const result = await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: { branding: { appName: "Acme" } },
    });
    expect(result.overrides).toEqual({ branding: { appName: "Acme" } });
    expect(result.updatedAt).not.toBeNull();

    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .where("tenantId", "=", "t1")
      .execute();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toEqual({
      branding: { appName: "Acme" },
    });
  });

  it("upserts (updates existing row)", async () => {
    await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: { branding: { appName: "First" } },
    });
    await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: { branding: { appName: "Second" } },
    });

    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .where("tenantId", "=", "t1")
      .execute();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toEqual({
      branding: { appName: "Second" },
    });
  });

  it("deletes the row when called with empty object (clears overrides)", async () => {
    await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: { branding: { appName: "Acme" } },
    });
    const result = await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: {},
    });
    expect(result.overrides).toEqual({});
    expect(result.updatedAt).toBeNull();

    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .where("tenantId", "=", "t1")
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("rejects invalid JSON with INVALID_RUNTIME_CONFIG", async () => {
    await expect(
      mutation().setRuntimeConfig(undefined, {
        tenantId: "t1",
        json: { app: { logLevel: "VERBOSE" } },
      }),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({
        code: "INVALID_RUNTIME_CONFIG",
      }),
    });
  });

  it("rejects unknown top-level key", async () => {
    await expect(
      mutation().setRuntimeConfig(undefined, {
        tenantId: "t1",
        json: { unknownKey: "x" },
      }),
    ).rejects.toThrow(/Invalid runtime config/);
  });

  it("returns effective populated even when row is empty after delete", async () => {
    const result = await mutation().setRuntimeConfig(undefined, {
      tenantId: "t1",
      json: {},
    });
    expect(result.effective).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
  });

  it("isolates tenants", async () => {
    await mutation().setRuntimeConfig(undefined, {
      tenantId: "tenant-a",
      json: { branding: { appName: "Alpha" } },
    });
    await mutation().setRuntimeConfig(undefined, {
      tenantId: "tenant-b",
      json: { branding: { appName: "Beta" } },
    });

    const a = await query().runtimeConfig(undefined, {
      tenantId: "tenant-a",
    });
    const b = await query().runtimeConfig(undefined, {
      tenantId: "tenant-b",
    });
    expect(a.overrides).toEqual({ branding: { appName: "Alpha" } });
    expect(b.overrides).toEqual({ branding: { appName: "Beta" } });
  });
});
