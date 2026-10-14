import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up as upSecrets } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { NOTIFY_CHANNEL } from "../services/secrets-service.js";
import { orphanPurgeMode, purgeOrphanTenantRows, purgeTenantRows } from "../tenant-purge.js";
import { up as upEnvs } from "../../../processors/vetra-cloud-environment/migrations.js";
import type { DB as EnvDB } from "../../../processors/vetra-cloud-environment/schema.js";

/**
 * Production namespaces are separate Postgres schemas; nothing lives in
 * public. Every statement must resolve through the schema-bound instance.
 */
async function namespaces() {
  const pg = new PGlite();
  const root = new Kysely<any>({ dialect: new PGliteDialect(pg) });
  await pg.exec(`CREATE SCHEMA ns_secrets; CREATE SCHEMA ns_envs;`);
  const secrets = root.withSchema("ns_secrets") as unknown as Kysely<SecretsDB>;
  const envs = root.withSchema("ns_envs") as unknown as Kysely<EnvDB>;
  await upSecrets(secrets as Kysely<any>);
  await upEnvs(envs as Kysely<any>);
  return { pg, root, secrets, envs };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const NOW = "2026-10-14T00:00:00.000Z";
async function seedTenant(db: Kysely<SecretsDB>, tenantId: string, envVars = 1, secrets = 1) {
  for (let i = 0; i < envVars; i++) {
    await db.insertInto("tenant_env_vars").values({ tenantId, key: `V${i}`, value: "v", updatedAt: NOW }).execute();
  }
  for (let i = 0; i < secrets; i++) {
    await db
      .insertInto("tenant_secrets")
      .values({ tenantId, key: `S${i}`, updatedAt: NOW, ciphertext: "vault:v1:x" })
      .execute();
  }
}
async function tenantsLeft(db: Kysely<SecretsDB>): Promise<string[]> {
  const a = await db.selectFrom("tenant_env_vars").select("tenantId").execute();
  const b = await db.selectFrom("tenant_secrets").select("tenantId").execute();
  return [...new Set([...a, ...b].map((r) => r.tenantId))].sort();
}

describe("purgeTenantRows", () => {
  it("deletes one tenant's env vars and secrets, nobody else's, and notifies the controller", async () => {
    const { pg, root, secrets } = await namespaces();
    cleanup = () => root.destroy();
    await seedTenant(secrets, "t-a", 2, 3);
    await seedTenant(secrets, "t-b");
    const notified: string[] = [];
    await pg.listen(NOTIFY_CHANNEL, (p) => notified.push(p));

    expect(await purgeTenantRows(secrets, "t-a")).toStrictEqual({ envVars: 2, secrets: 3 });
    expect(await tenantsLeft(secrets)).toStrictEqual(["t-b"]);
    // Idempotent: nothing left, no second notify.
    expect(await purgeTenantRows(secrets, "t-a")).toStrictEqual({ envVars: 0, secrets: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(notified).toStrictEqual(["t-a"]);
  });
});

describe("purgeOrphanTenantRows", () => {
  async function seedEnv(envs: Kysely<EnvDB>, id: string, tenantId: string | null, subdomain: string | null = null) {
    await envs.insertInto("environments").values({ id, tenantId, subdomain } as never).execute();
  }

  it("purges tenants with no environment, keeps live ones, inside the namespaces only", async () => {
    const { pg, root, secrets, envs } = await namespaces();
    cleanup = () => root.destroy();
    await seedEnv(envs, "doc-1", "live-1");
    await seedEnv(envs, "doc-2", "live-2");
    // Legacy row without the tenantId column: live through subdomain + id.
    await seedEnv(envs, "abcd1234-xyz", null, "legacy");
    for (const t of ["live-1", "live-2", "legacy-abcd1234", "gone-1"]) await seedTenant(secrets, t);

    const first = await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs });
    expect(first).toStrictEqual({ purged: ["gone-1"], skippedForSafety: false });
    expect(await tenantsLeft(secrets)).toStrictEqual(["legacy-abcd1234", "live-1", "live-2"]);
    // Idempotent.
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).toStrictEqual({
      purged: [],
      skippedForSafety: false,
    });
    const publicTables = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(publicTables.rows).toStrictEqual([]);
  });

  it("purges nothing when no environment is known (empty or fresh projection)", async () => {
    const { root, secrets, envs } = await namespaces();
    cleanup = () => root.destroy();
    await seedTenant(secrets, "t-1");
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).toStrictEqual({
      purged: [],
      skippedForSafety: true,
    });
    expect(await tenantsLeft(secrets)).toStrictEqual(["t-1"]);
  });

  it("purges nothing when more than half the tenants would go (circuit breaker)", async () => {
    const { root, secrets, envs } = await namespaces();
    cleanup = () => root.destroy();
    await seedEnv(envs, "doc-1", "live-1");
    for (const t of ["live-1", "gone-1", "gone-2"]) await seedTenant(secrets, t);
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).toStrictEqual({
      purged: [],
      skippedForSafety: true,
    });
    expect(await tenantsLeft(secrets)).toHaveLength(3);
    // An explicit higher fraction lets an operator run it anyway.
    expect(
      (await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, maxPurgeFraction: 1 })).purged,
    ).toStrictEqual(["gone-1", "gone-2"]);
  });

  it("purges nothing when the projection table does not exist", async () => {
    const pg = new PGlite();
    const root = new Kysely<any>({ dialect: new PGliteDialect(pg) });
    cleanup = () => root.destroy();
    await pg.exec(`CREATE SCHEMA ns_secrets; CREATE SCHEMA ns_envs;`);
    const secrets = root.withSchema("ns_secrets") as unknown as Kysely<SecretsDB>;
    await upSecrets(secrets as Kysely<any>);
    await seedTenant(secrets, "t-1");
    await expect(
      purgeOrphanTenantRows({ secretsDb: secrets, envDb: root.withSchema("ns_envs") as unknown as Kysely<EnvDB> }),
    ).rejects.toThrow();
    expect(await tenantsLeft(secrets)).toStrictEqual(["t-1"]);
  });
});

describe("orphan sweep: dry run and mode", () => {
  it("a dry run reports the orphans and deletes nothing", async () => {
    const { root, secrets, envs } = await namespaces();
    cleanup = () => root.destroy();
    await envs.insertInto("environments").values({ id: "doc-1", tenantId: "live-1" } as never).execute();
    for (const t of ["live-1", "live-2", "gone-1"]) await seedTenant(secrets, t);
    // 2 of 3 would go: the breaker holds even in a dry run.
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, dryRun: true })).toStrictEqual({
      purged: [],
      skippedForSafety: true,
    });
    await envs.insertInto("environments").values({ id: "doc-2", tenantId: "live-2" } as never).execute();
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, dryRun: true })).toStrictEqual({
      purged: ["gone-1"],
      skippedForSafety: false,
    });
    expect(await tenantsLeft(secrets)).toStrictEqual(["gone-1", "live-1", "live-2"]);
  });

  it.each([
    [undefined, "dry-run"],
    ["", "dry-run"],
    ["yes", "dry-run"],
    ["true", "purge"],
    [" TRUE ", "purge"],
    ["false", "off"],
  ])("SECRETS_ORPHAN_PURGE=%j is %s", (v, mode) => {
    expect(orphanPurgeMode(v)).toBe(mode);
  });
});
