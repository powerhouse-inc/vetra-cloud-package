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
