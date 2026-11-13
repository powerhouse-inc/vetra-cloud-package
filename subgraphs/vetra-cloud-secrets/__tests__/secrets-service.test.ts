import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import {
  createSecretsService,
  ManagedSecretKeyError,
  NOTIFY_CHANNEL,
  PLATFORM_MANAGED_KEYS,
  purgeTenantRows,
  STUDIO_LAUNCH_SECRET_KEY,
  WORKFLOWS_MASTER_KEY,
  type SecretsService,
} from "../services/secrets-service.js";
import type { OpenBaoTransitClient } from "../openbao-transit.js";

let db: Kysely<SecretsDB>;
let service: SecretsService;

const mockTransit: OpenBaoTransitClient = {
  authenticate: vi.fn(),
  ensureTenantKey: vi.fn().mockResolvedValue(undefined),
  keyFor: vi.fn().mockImplementation((tenantId: string) => `vetra-tenant-${tenantId}`),
  encrypt: vi
    .fn()
    .mockImplementation(
      async (tenantId: string, plaintext: string) => `vault:v1:${tenantId}:${plaintext}`,
    ),
  decrypt: vi
    .fn()
    .mockImplementation(async (_tenantId: string, ciphertext: string) =>
      ciphertext.replace(/^vault:v\d+:[^:]+:/, ""),
    ),
} as never;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  vi.clearAllMocks();
  service = createSecretsService({ db, transit: mockTransit });
});

afterEach(async () => {
  await db.destroy();
});

describe("setSecrets (batch)", () => {
  it("upserts every entry, encrypted, in one call", async () => {
    await service.setSecrets("tenant-a", [
      { key: "ANTHROPIC_API_KEY", value: "sk-real" },
      { key: "VETRA_ANTHROPIC_API_KEY", value: "sk-real" },
      { key: "ADMINS", value: "0xabc" },
    ]);

    const rows = await db
      .selectFrom("tenant_secrets")
      .select(["key", "ciphertext"])
      .where("tenantId", "=", "tenant-a")
      .orderBy("key", "asc")
      .execute();

    expect(rows.map((r) => r.key)).toEqual([
      "ADMINS",
      "ANTHROPIC_API_KEY",
      "VETRA_ANTHROPIC_API_KEY",
    ]);
    // Each value encrypted via the tenant's transit key.
    expect(rows.find((r) => r.key === "ADMINS")?.ciphertext).toBe(
      "vault:v1:tenant-a:0xabc",
    );
    expect(mockTransit.encrypt).toHaveBeenCalledTimes(3);
    expect(mockTransit.ensureTenantKey).toHaveBeenCalledWith("tenant-a");
  });

  it("is an upsert — re-running updates ciphertext, no duplicate rows", async () => {
    await service.setSecrets("tenant-a", [{ key: "ANTHROPIC_API_KEY", value: "old" }]);
    await service.setSecrets("tenant-a", [{ key: "ANTHROPIC_API_KEY", value: "new" }]);

    const rows = await db
      .selectFrom("tenant_secrets")
      .select(["key", "ciphertext"])
      .where("tenantId", "=", "tenant-a")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).toBe("vault:v1:tenant-a:new");
  });

  it("rejects an invalid key (whole batch fails before any write)", async () => {
    await expect(
      service.setSecrets("tenant-a", [
        { key: "ANTHROPIC_API_KEY", value: "ok" },
        { key: "bad-key", value: "x" },
      ]),
    ).rejects.toThrow();

    const rows = await db
      .selectFrom("tenant_secrets")
      .selectAll()
      .where("tenantId", "=", "tenant-a")
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("no-ops on an empty batch", async () => {
    await service.setSecrets("tenant-a", []);
    expect(mockTransit.encrypt).not.toHaveBeenCalled();
  });
});

describe("secretFingerprint", () => {
  it("is the sha256 of the value, null for a missing key, and never the value", async () => {
    await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1");
    const { createHash } = await import("node:crypto");
    expect(await service.secretFingerprint("tenant-a", WORKFLOWS_MASTER_KEY)).toBe(
      createHash("sha256").update("k1").digest("hex"),
    );
    expect(await service.secretFingerprint("tenant-a", "NOPE")).toBeNull();
    expect(await service.secretFingerprint("tenant-b", WORKFLOWS_MASTER_KEY)).toBeNull();
  });
});

describe("ensureSecret (managed secrets)", () => {
  async function ciphertextOf(tenantId: string, key: string) {
    const row = await db
      .selectFrom("tenant_secrets")
      .select("ciphertext")
      .where("tenantId", "=", tenantId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.ciphertext;
  }

  it("writes the generated value when the tenant has none", async () => {
    const wrote = await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1");
    expect(wrote).toBe(true);
    expect(await ciphertextOf("tenant-a", WORKFLOWS_MASTER_KEY)).toBe(
      "vault:v1:tenant-a:k1",
    );
  });

  it("never overwrites, and skips generate and encrypt once the key exists", async () => {
    await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1");
    vi.clearAllMocks();
    const generate = vi.fn(() => "k2");

    const wrote = await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, generate);

    expect(wrote).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(mockTransit.encrypt).not.toHaveBeenCalled();
    expect(await ciphertextOf("tenant-a", WORKFLOWS_MASTER_KEY)).toBe(
      "vault:v1:tenant-a:k1",
    );
  });

  it("keeps the first value when two calls race", async () => {
    const results = await Promise.all([
      service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1"),
      service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k2"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await ciphertextOf("tenant-a", WORKFLOWS_MASTER_KEY);
    expect(["vault:v1:tenant-a:k1", "vault:v1:tenant-a:k2"]).toContain(stored);
  });

  it("notifies the controller only when it writes", async () => {
    const pglite = new PGlite();
    const notifyDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(pglite) });
    await up(notifyDb);
    const notified: string[] = [];
    await pglite.listen(NOTIFY_CHANNEL, (payload) => notified.push(payload));
    const notifying = createSecretsService({ db: notifyDb, transit: mockTransit });

    await notifying.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1");
    await notifying.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k2");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notified).toEqual(["tenant-a"]);
    await notifyDb.destroy();
  });

  it("notifyTenant notifies the controller without writing anything", async () => {
    const pglite = new PGlite();
    const notifyDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(pglite) });
    await up(notifyDb);
    const notified: string[] = [];
    await pglite.listen(NOTIFY_CHANNEL, (payload) => notified.push(payload));
    const s = createSecretsService({ db: notifyDb, transit: mockTransit });
    await s.notifyTenant("tenant-a");
    await new Promise((r) => setTimeout(r, 20));
    expect(notified).toEqual(["tenant-a"]);
    expect(await s.listSecretKeys("tenant-a")).toEqual([]);
    expect(await s.listEnvVars("tenant-a")).toEqual([]);
    await notifyDb.destroy();
  });

  it("is scoped per tenant", async () => {
    await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "a");
    expect(
      await service.ensureSecret("tenant-b", WORKFLOWS_MASTER_KEY, () => "b"),
    ).toBe(true);
  });

  it("refuses to let the user-facing writes replace or delete a managed key", async () => {
    await service.ensureSecret("tenant-a", WORKFLOWS_MASTER_KEY, () => "k1");

    await expect(
      service.setSecret("tenant-a", WORKFLOWS_MASTER_KEY, "mine"),
    ).rejects.toThrow(ManagedSecretKeyError);
    await expect(
      service.setSecrets("tenant-a", [{ key: WORKFLOWS_MASTER_KEY, value: "mine" }]),
    ).rejects.toThrow(ManagedSecretKeyError);
    await expect(
      service.setEnvVar("tenant-a", WORKFLOWS_MASTER_KEY, "mine"),
    ).rejects.toThrow(ManagedSecretKeyError);
    await expect(
      service.deleteSecret("tenant-a", WORKFLOWS_MASTER_KEY),
    ).rejects.toThrow(ManagedSecretKeyError);

    expect(await ciphertextOf("tenant-a", WORKFLOWS_MASTER_KEY)).toBe(
      "vault:v1:tenant-a:k1",
    );
  });
});

describe("replaceTenantConfig", () => {
  const ciphertextOf = async (tenantId: string, key: string) =>
    (
      await db
        .selectFrom("tenant_secrets")
        .select("ciphertext")
        .where("tenantId", "=", tenantId)
        .where("key", "=", key)
        .executeTakeFirst()
    )?.ciphertext;
  const rows = async (tenantId: string) => ({
    envVars: await db
      .selectFrom("tenant_env_vars")
      .select(["key", "value"])
      .where("tenantId", "=", tenantId)
      .orderBy("key")
      .execute(),
    secrets: (
      await db
        .selectFrom("tenant_secrets")
        .select(["key", "ciphertext"])
        .where("tenantId", "=", tenantId)
        .orderBy("key")
        .execute()
    ).map((r) => r.key),
  });

  it("drops everything not given (planted env vars and secrets), keeps managed keys, writes the rest", async () => {
    await service.setEnvVar("t", "ANTHROPIC_BASE_URL", "https://evil.example");
    await service.setEnvVar("t", "VETRA_REQUIRE_API_KEY", "false"); // tampered value
    await service.setSecret("t", "PLANTED", "x");
    await service.ensureSecret("t", WORKFLOWS_MASTER_KEY, () => "master");
    await service.setEnvVar("other", "KEEP", "1");

    await service.replaceTenantConfig("t", [
      { key: "VETRA_REQUIRE_API_KEY", value: "true", secret: false },
      { key: "ANTHROPIC_API_KEY", value: "sk-ant", secret: true },
      { key: "EMPTY_SECRET", value: "", secret: true },
    ]);

    expect(await rows("t")).toStrictEqual({
      envVars: [{ key: "VETRA_REQUIRE_API_KEY", value: "true" }],
      secrets: ["ANTHROPIC_API_KEY", WORKFLOWS_MASTER_KEY],
    });
    expect(await ciphertextOf("t", WORKFLOWS_MASTER_KEY)).toBe("vault:v1:t:master");
    expect(await rows("other")).toStrictEqual({ envVars: [{ key: "KEEP", value: "1" }], secrets: [] });
  });

  it("skips entries the user paths would refuse (invalid, reserved or managed keys)", async () => {
    await service.ensureSecret("t", WORKFLOWS_MASTER_KEY, () => "master");
    await service.replaceTenantConfig("t", [
      { key: "lower", value: "x", secret: false },
      { key: "PH_CONNECT_CONFIG_JSON", value: "{}", secret: false },
      { key: WORKFLOWS_MASTER_KEY, value: "mine", secret: true },
      { key: "OK", value: "1", secret: false },
    ]);
    expect((await rows("t")).envVars).toStrictEqual([{ key: "OK", value: "1" }]);
    expect(await ciphertextOf("t", WORKFLOWS_MASTER_KEY)).toBe("vault:v1:t:master");
  });

  it("is one write with one notify", async () => {
    const pglite = new PGlite();
    const notifyDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(pglite) });
    await up(notifyDb);
    const notified: string[] = [];
    await pglite.listen(NOTIFY_CHANNEL, (payload) => notified.push(payload));
    const s = createSecretsService({ db: notifyDb, transit: mockTransit });
    await s.replaceTenantConfig("t", [
      { key: "A", value: "1", secret: false },
      { key: "B", value: "2", secret: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notified).toEqual(["t"]);
    await notifyDb.destroy();
  });
});

describe("Studio launch secret (a rotatable managed key)", () => {
  const keysOf = async (tenantId: string) =>
    (
      await db
        .selectFrom("tenant_secrets")
        .select(["key", "ciphertext"])
        .where("tenantId", "=", tenantId)
        .orderBy("key")
        .execute()
    ).map((r) => [r.key, r.ciphertext]);

  it("is refused by every user path", async () => {
    const v = randomBytes(32).toString("hex");
    await expect(service.setSecret("t", STUDIO_LAUNCH_SECRET_KEY, v)).rejects.toBeInstanceOf(
      ManagedSecretKeyError,
    );
    await expect(
      service.setSecrets("t", [{ key: STUDIO_LAUNCH_SECRET_KEY, value: v }]),
    ).rejects.toBeInstanceOf(ManagedSecretKeyError);
    await expect(service.setEnvVar("t", STUDIO_LAUNCH_SECRET_KEY, v)).rejects.toBeInstanceOf(
      ManagedSecretKeyError,
    );
    await expect(service.deleteSecret("t", STUDIO_LAUNCH_SECRET_KEY)).rejects.toBeInstanceOf(
      ManagedSecretKeyError,
    );
  });

  it("setManagedSecret overwrites that one key only; never the workflows master key", async () => {
    await service.setSecret("t", "OPENROUTER_API_KEY", "sk-or");
    await service.setEnvVar("t", "ADMINS", "0xabc");
    await service.ensureSecret("t", WORKFLOWS_MASTER_KEY, () => "master");
    const first = randomBytes(32).toString("hex");
    const second = randomBytes(32).toString("hex");
    expect(await service.ensureSecret("t", STUDIO_LAUNCH_SECRET_KEY, () => first)).toBe(true);
    await service.setManagedSecret("t", STUDIO_LAUNCH_SECRET_KEY, second);
    expect(await keysOf("t")).toStrictEqual([
      ["OPENROUTER_API_KEY", "vault:v1:t:sk-or"],
      [WORKFLOWS_MASTER_KEY, "vault:v1:t:master"],
      [STUDIO_LAUNCH_SECRET_KEY, `vault:v1:t:${second}`],
    ]);
    expect(await service.listEnvVars("t")).toStrictEqual([{ key: "ADMINS", value: "0xabc" }]);
    await expect(service.setManagedSecret("t", WORKFLOWS_MASTER_KEY, "x")).rejects.toBeInstanceOf(
      ManagedSecretKeyError,
    );
    await expect(service.setManagedSecret("t", "OPENROUTER_API_KEY", "x")).rejects.toBeInstanceOf(
      ManagedSecretKeyError,
    );
    await expect(service.setManagedSecret("t", STUDIO_LAUNCH_SECRET_KEY, "")).rejects.toThrow();
  });

  it("replaceTenantConfig writes it from `managed`, ignores it in the plain entries, and keeps it when absent", async () => {
    const old = randomBytes(32).toString("hex");
    const fresh = randomBytes(32).toString("hex");
    await service.ensureSecret("t", STUDIO_LAUNCH_SECRET_KEY, () => old);
    // Absent: kept.
    await service.replaceTenantConfig("t", [{ key: "A", value: "1", secret: true }]);
    expect(await keysOf("t")).toContainEqual([STUDIO_LAUNCH_SECRET_KEY, `vault:v1:t:${old}`]);
    // In the plain entries (as a document could declare it): ignored.
    await service.replaceTenantConfig("t", [
      { key: STUDIO_LAUNCH_SECRET_KEY, value: "declared", secret: true },
    ]);
    expect(await keysOf("t")).toStrictEqual([[STUDIO_LAUNCH_SECRET_KEY, `vault:v1:t:${old}`]]);
    // From Vetra (managed): overwritten in the same write.
    await service.replaceTenantConfig(
      "t",
      [{ key: "A", value: "1", secret: true }],
      [{ key: STUDIO_LAUNCH_SECRET_KEY, value: fresh }],
    );
    expect(await keysOf("t")).toStrictEqual([
      ["A", "vault:v1:t:1"],
      [STUDIO_LAUNCH_SECRET_KEY, `vault:v1:t:${fresh}`],
    ]);
    await expect(
      service.replaceTenantConfig("t", [], [{ key: WORKFLOWS_MASTER_KEY, value: "x" }]),
    ).rejects.toBeInstanceOf(ManagedSecretKeyError);
  });

  it("replaceTenantConfig takes the last of duplicate managed entries", async () => {
    const a = randomBytes(32).toString("hex");
    const b = randomBytes(32).toString("hex");
    await service.replaceTenantConfig(
      "t",
      [],
      [
        { key: STUDIO_LAUNCH_SECRET_KEY, value: a },
        { key: STUDIO_LAUNCH_SECRET_KEY, value: b },
      ],
    );
    expect(await keysOf("t")).toStrictEqual([[STUDIO_LAUNCH_SECRET_KEY, `vault:v1:t:${b}`]]);
  });

  it("goes with the tenant on a purge (the workflows master key stays)", async () => {
    await service.ensureSecret("t", WORKFLOWS_MASTER_KEY, () => "master");
    await service.ensureSecret("t", STUDIO_LAUNCH_SECRET_KEY, () => randomBytes(32).toString("hex"));
    expect(await purgeTenantRows(db, "t")).toStrictEqual({ envVars: 0, secrets: 1 });
    expect(await keysOf("t")).toStrictEqual([[WORKFLOWS_MASTER_KEY, "vault:v1:t:master"]]);
  });
});

describe("platform-managed keys (user-facing service)", () => {
  async function ciphertextOf(tenantId: string, key: string) {
    const row = await db
      .selectFrom("tenant_secrets")
      .select("ciphertext")
      .where("tenantId", "=", tenantId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.ciphertext;
  }

  const LISTED = [
    "VETRA_LICENSING_URL",
    "VETRA_REPORTING_TOKEN",
    "VETRA_MODEL",
    "VETRA_MODEL_FALLBACKS",
    "OPENROUTER_API_KEY",
    "VETRA_GATE_TOKEN",
    "ADMINS",
    "CI",
    "npm_config_node_linker",
    "PH_ATTACHMENT_URL_SIGNING_SECRET",
    "PH_REGISTRY_URL",
    "VETRA_CLOUD_RENOWN_URL",
    "VETRA_CLOUD_SWITCHBOARD_URL",
    "VETRA_ENVIRONMENT_ID",
    "VETRA_OBSERVABILITY_CONSENT",
    "VETRA_SESSION_EXPORT_SECRET",
    "VETRA_STUDIO_LAUNCH_SECRET",
    "PH_WORKFLOWS_SECRETS_MASTER_KEY",
  ];

  it("covers every key the console shows as set by Vetra", () => {
    expect([...PLATFORM_MANAGED_KEYS].sort()).toEqual([...LISTED].sort());
  });

  it.each(LISTED)("refuses set and delete of %s, leaving Vetra's value", async (key) => {
    const user = createSecretsService({ db, transit: mockTransit, userFacing: true });
    // Vetra's own value, as an internal writer would have put it.
    await db
      .insertInto("tenant_env_vars")
      .values({ tenantId: "t", key, value: "vetra", updatedAt: "x" })
      .execute();
    await db
      .insertInto("tenant_secrets")
      .values({ tenantId: "t", key, ciphertext: "vault:v1:t:vetra", updatedAt: "x" })
      .execute();

    const attempts = [
      user.setEnvVar("t", key, "mine"),
      user.deleteEnvVar("t", key),
      user.setSecret("t", key, "mine"),
      user.setSecrets("t", [{ key: "FINE_KEY", value: "v" }, { key, value: "mine" }]),
      user.deleteSecret("t", key),
    ];
    for (const a of attempts) {
      await expect(a).rejects.toMatchObject({ name: "ManagedSecretKeyError", code: "MANAGED_KEY", key });
    }

    expect(
      await db.selectFrom("tenant_env_vars").select("value").where("key", "=", key).execute(),
    ).toEqual([{ value: "vetra" }]);
    expect(await ciphertextOf("t", key)).toBe("vault:v1:t:vetra");
    // The batch failed as a whole: its valid entry was not written either.
    expect(await ciphertextOf("t", "FINE_KEY")).toBeUndefined();
  });

  it("still lets users set and delete their own keys", async () => {
    const user = createSecretsService({ db, transit: mockTransit, userFacing: true });
    await user.setEnvVar("t", "MY_VAR", "1");
    await user.setSecret("t", "MY_SECRET", "s");
    expect(await user.deleteEnvVar("t", "MY_VAR")).toBe(true);
    expect(await user.deleteSecret("t", "MY_SECRET")).toBe(true);
  });

  it("the internal service keeps writing them (Vetra's own writers)", async () => {
    // reporting.ts
    await service.setSecrets("t", [
      { key: "VETRA_REPORTING_TOKEN", value: "tok" },
      { key: "VETRA_LICENSING_URL", value: "https://l" },
    ]);
    // broker.ts
    await service.setEnvVar("t", "VETRA_MODEL", "m");
    await service.setEnvVar("t", "VETRA_MODEL_FALLBACKS", "a,b");
    await service.setSecret("t", "OPENROUTER_API_KEY", "or");
    expect(await service.deleteSecret("t", "OPENROUTER_API_KEY")).toBe(true);
    // gitops routing of create-env.ts's document env
    await service.setEnvVar("t", "VETRA_ENVIRONMENT_ID", "doc-1");
    // claim.ts
    await service.replaceTenantConfig("t2", [
      { key: "ADMINS", value: "0xabc", secret: true },
      { key: "CI", value: "true", secret: false },
      { key: "VETRA_SESSION_EXPORT_SECRET", value: "x", secret: true },
    ]);

    expect(await ciphertextOf("t", "VETRA_REPORTING_TOKEN")).toBe("vault:v1:t:tok");
    expect(await ciphertextOf("t2", "ADMINS")).toBe("vault:v1:t2:0xabc");
    expect(
      (await service.listEnvVars("t")).map((r) => r.key),
    ).toEqual(["VETRA_ENVIRONMENT_ID", "VETRA_MODEL", "VETRA_MODEL_FALLBACKS"]);
    expect((await service.listEnvVars("t2")).map((r) => r.key)).toEqual(["CI"]);
  });
});
