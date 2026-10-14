import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up as upSecrets } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { NOTIFY_CHANNEL, WORKFLOWS_MASTER_KEY } from "../services/secrets-service.js";
import { orphanPurgeMode, orphanToken, purgeOrphanTenantRows, purgeTenantRows } from "../tenant-purge.js";
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

  it("keeps the managed workflows master key (data encrypted under it may outlive the env)", async () => {
    const { root, secrets } = await namespaces();
    cleanup = () => root.destroy();
    await seedTenant(secrets, "t-a");
    await secrets
      .insertInto("tenant_secrets")
      .values({ tenantId: "t-a", key: WORKFLOWS_MASTER_KEY, updatedAt: NOW, ciphertext: "vault:v1:k" })
      .execute();
    expect(await purgeTenantRows(secrets, "t-a")).toStrictEqual({ envVars: 1, secrets: 1 });
    const left = await secrets.selectFrom("tenant_secrets").select("key").execute();
    expect(left).toStrictEqual([{ key: WORKFLOWS_MASTER_KEY }]);
  });
});

describe("purgeOrphanTenantRows: one-shot, confirmed, capped", () => {
  async function seedEnv(envs: Kysely<EnvDB>, id: string, tenantId: string | null, subdomain: string | null = null) {
    await envs.insertInto("environments").values({ id, tenantId, subdomain } as never).execute();
  }
  async function fleet() {
    const ns = await namespaces();
    cleanup = () => ns.root.destroy();
    await seedEnv(ns.envs, "doc-1", "live-1");
    await seedEnv(ns.envs, "doc-2", "live-2");
    // Legacy row without the tenantId column: live through subdomain + id.
    await seedEnv(ns.envs, "abcd1234-xyz", null, "legacy");
    for (const t of ["live-1", "live-2", "legacy-abcd1234", "gone-1"]) await seedTenant(ns.secrets, t);
    return ns;
  }

  it("without a confirmation it is a dry run that reports the orphans and their token", async () => {
    const { secrets, envs } = await fleet();
    const out = await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs });
    expect(out).toStrictEqual({ outcome: "DRY_RUN", orphans: ["gone-1"], token: orphanToken(["gone-1"]) });
    expect(out.token).toMatch(/^1:[0-9a-f]{16}$/);
    expect(await tenantsLeft(secrets)).toHaveLength(4);
  });

  it("purges only with the exact token of the dry run, records it, and never runs again", async () => {
    const { pg, secrets, envs } = await fleet();
    const { token } = await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs });
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, confirm: "1:0000000000000000" })).outcome).toBe(
      "TOKEN_MISMATCH",
    );
    expect(await tenantsLeft(secrets)).toHaveLength(4);
    expect(await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, confirm: token })).toStrictEqual({
      outcome: "PURGED",
      orphans: ["gone-1"],
      token,
    });
    expect(await tenantsLeft(secrets)).toStrictEqual(["legacy-abcd1234", "live-1", "live-2"]);
    // A later orphan is never swept by the same (or any) confirmation again.
    await seedTenant(secrets, "gone-2");
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, confirm: token })).outcome).toBe("ALREADY_DONE");
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).outcome).toBe("ALREADY_DONE");
    expect(await tenantsLeft(secrets)).toContain("gone-2");
    // Recorded inside the namespace; nothing in public.
    const done = await pg.query<{ token: string }>(`SELECT token FROM ns_secrets.tenant_orphan_purges`);
    expect(done.rows.map((r) => r.token)).toStrictEqual([token]);
    const publicTables = await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(publicTables.rows).toStrictEqual([]);
  });

  it("a different orphan set (a projection still replaying) changes the token: the old confirmation purges nothing", async () => {
    const { secrets, envs } = await fleet();
    const { token } = await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs });
    await seedTenant(secrets, "gone-2");
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, confirm: token })).outcome).toBe("TOKEN_MISMATCH");
    expect(await tenantsLeft(secrets)).toHaveLength(5);
  });

  it("tenants holding only the managed master key are not orphans", async () => {
    const { secrets, envs } = await fleet();
    await secrets
      .insertInto("tenant_secrets")
      .values({ tenantId: "gone-2", key: WORKFLOWS_MASTER_KEY, updatedAt: NOW, ciphertext: "vault:v1:k" })
      .execute();
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).orphans).toStrictEqual(["gone-1"]);
  });

  it("refuses when no environment is known, over half the tenants would go, or over the absolute cap", async () => {
    const empty = await namespaces();
    await seedTenant(empty.secrets, "t-1");
    expect((await purgeOrphanTenantRows({ secretsDb: empty.secrets, envDb: empty.envs })).outcome).toBe("SKIPPED_SAFETY");
    await empty.root.destroy();

    const { secrets, envs } = await fleet();
    await seedTenant(secrets, "gone-2");
    await seedTenant(secrets, "gone-3");
    await seedTenant(secrets, "gone-4");
    // 4 of 7 would go.
    const half = await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs });
    expect(half.outcome).toBe("SKIPPED_SAFETY");
    expect(
      (await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, confirm: half.token })).outcome,
    ).toBe("SKIPPED_SAFETY");
    // Fraction raised, absolute cap of 3: still refused.
    expect(
      (await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs, maxPurgeFraction: 1, maxTenants: 3, confirm: half.token }))
        .outcome,
    ).toBe("SKIPPED_SAFETY");
    expect(await tenantsLeft(secrets)).toHaveLength(7);
  });

  it("reports NONE when nothing is orphaned", async () => {
    const { secrets, envs } = await namespaces();
    cleanup = async () => undefined;
    await seedEnv(envs, "doc-1", "live-1");
    await seedTenant(secrets, "live-1");
    expect((await purgeOrphanTenantRows({ secretsDb: secrets, envDb: envs })).outcome).toBe("NONE");
  });

  it("throws (purging nothing) when the projection table does not exist", async () => {
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

describe("SECRETS_ORPHAN_PURGE", () => {
  it.each([
    [undefined, { mode: "dry-run" }],
    ["", { mode: "dry-run" }],
    ["false", { mode: "off" }],
    [" OFF ", { mode: "off" }],
    ["true", { mode: "confirm", token: "true" }],
    [" 1:abcdef0123456789 ", { mode: "confirm", token: "1:abcdef0123456789" }],
  ])("%j is %j", (v, mode) => {
    expect(orphanPurgeMode(v)).toStrictEqual(mode);
  });
});
