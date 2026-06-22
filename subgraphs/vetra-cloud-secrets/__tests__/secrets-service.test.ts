import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { createSecretsService, type SecretsService } from "../services/secrets-service.js";
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
