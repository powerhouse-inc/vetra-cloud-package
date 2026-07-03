import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up as accessUp } from "../db/migrations.js";
import type { VetraAccessCodesDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import { up as secretsUp } from "../../vetra-cloud-secrets/db/migrations.js";
import type { SecretsDB } from "../../vetra-cloud-secrets/db/schema.js";
import { createSecretsService } from "../../vetra-cloud-secrets/services/secrets-service.js";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";

/**
 * End-to-end through the REAL production code paths: the access-codes resolvers
 * + the vetra-cloud-secrets service, against two real (PGlite) namespaced DBs.
 * Only OpenBao and Renown are substituted — a symmetric in-memory transit (so
 * we can prove the encrypt/decrypt round-trip) and a plain resolver ctx (the
 * gateway normally derives the DID from the verified token).
 *
 * Proves: admin attaches a key (encrypted at rest under the access-codes
 * pseudo-tenant) -> user redeems -> applyInviteCodeSecret decrypts and writes
 * it into the tenant secret store (re-encrypted per tenant) -> the original key
 * is recoverable for that tenant.
 */

const STUDIO_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "VETRA_ANTHROPIC_API_KEY",
  "VETRA_CLI_ANTHROPIC_API_KEY",
];
const API_KEY = "sk-ant-e2e-SUPERSECRET-0123456789";
const TENANT = "warm-newt-75-aa726a95";
const ADDR = "0x" + "a".repeat(40);
// Admin has its own address (listed in ADMINS); the caller (ADDR) is the
// redeeming user whose did:pkh must match its redemptions.
const ADMIN_ADDR = "0x" + "b".repeat(40);
process.env.ADMINS = ADMIN_ADDR;

let accessDb: Kysely<VetraAccessCodesDB>;
let secretsDb: Kysely<SecretsDB>;
let resolvers: ReturnType<typeof createResolvers>;
const ensured = new Set<string>();

// Symmetric, tenant-scoped fake of the OpenBao transit engine: ciphertext is
// `enc:<tenant>:<base64(plaintext)>`, so a value encrypted under tenant A can
// only be decrypted under tenant A — lets us assert key isolation too.
const transit: OpenBaoTransitClient = {
  authenticate: async () => "tok",
  keyFor: (t: string) => `vetra-tenant-${t}`,
  ensureTenantKey: async (t: string) => {
    ensured.add(t);
  },
  encrypt: async (t: string, plaintext: string) =>
    `enc:${t}:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  decrypt: async (t: string, ciphertext: string) => {
    const m = /^enc:([^:]+):(.*)$/.exec(ciphertext);
    if (!m || m[1] !== t) throw new Error(`wrong tenant key for decrypt: ${t}`);
    return Buffer.from(m[2], "base64").toString("utf8");
  },
} as unknown as OpenBaoTransitClient;

beforeEach(async () => {
  ensured.clear();
  accessDb = new Kysely<VetraAccessCodesDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  secretsDb = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await accessUp(accessDb);
  await secretsUp(secretsDb);
  const secretsService = createSecretsService({ db: secretsDb, transit });
  resolvers = createResolvers(accessDb, { transit, secretsService });
});

afterEach(async () => {
  await accessDb.destroy();
  await secretsDb.destroy();
});

const admin = { user: { address: ADMIN_ADDR, chainId: 1, networkId: "eip155" } };
const caller = { user: { address: ADDR, chainId: 1, networkId: "eip155" } };
const Q = () => resolvers.VetraAccessCodesQueries;
const M = () => resolvers.VetraAccessCodesMutations;

describe("e2e: invite-code Claude key -> tenant secret store", () => {
  it("attaches, redeems, injects, and the original key is recoverable per-tenant", async () => {
    // 1. Admin creates a code WITH an attached Claude key.
    const created = await M().createInviteCode(
      undefined,
      { code: "local-first", label: "Local-First", anthropicApiKey: API_KEY },
      admin,
    );
    expect(created.hasAnthropicKey).toBe(true);

    // At rest: stored ciphertext is encrypted under the access-codes pseudo-tenant,
    // never the plaintext key.
    const row = await accessDb
      .selectFrom("invite_codes")
      .select("anthropic_key_ciphertext")
      .where("code", "=", "local-first")
      .executeTakeFirstOrThrow();
    expect(row.anthropic_key_ciphertext).toBe(
      `enc:access-codes:${Buffer.from(API_KEY).toString("base64")}`,
    );
    expect(row.anthropic_key_ciphertext).not.toContain(API_KEY);

    // 2. The user (public) checks then redeems.
    expect(await Q().inviteCodeValid(undefined, { code: "local-first" })).toBe(true);
    const status = await M().redeemInviteCode(undefined, { code: "local-first" }, caller);
    expect(status.allowed).toBe(true);
    expect(status.hasAttachedKey).toBe(true);

    // 3. Studio provisioning asks the subgraph to inject the key server-side.
    const result = await M().applyInviteCodeSecret(
      undefined,
      { tenantId: TENANT, secretNames: STUDIO_SECRET_NAMES },
      caller,
    );
    expect(result.injected).toBe(true);
    expect(result.secretNames).toEqual(STUDIO_SECRET_NAMES);

    // 4. The secret store now holds all three names for this tenant, and each
    // decrypts back to the ORIGINAL key — encrypted under the tenant's own key.
    const secrets = await secretsDb
      .selectFrom("tenant_secrets")
      .select(["key", "ciphertext"])
      .where("tenantId", "=", TENANT)
      .orderBy("key", "asc")
      .execute();
    expect(secrets.map((s) => s.key).sort()).toEqual([...STUDIO_SECRET_NAMES].sort());
    for (const s of secrets) {
      expect(s.ciphertext).toBe(`enc:${TENANT}:${Buffer.from(API_KEY).toString("base64")}`);
      expect(await transit.decrypt(TENANT, s.ciphertext!)).toBe(API_KEY);
    }
    // Per-tenant key isolation actually exercised.
    expect(ensured.has("access-codes")).toBe(true);
    expect(ensured.has(TENANT)).toBe(true);
  });

  it("injects nothing when the caller's redeemed code carries no key", async () => {
    await M().createInviteCode(undefined, { code: "plain" }, admin);
    await M().redeemInviteCode(undefined, { code: "plain" }, caller);
    const result = await M().applyInviteCodeSecret(
      undefined,
      { tenantId: TENANT, secretNames: STUDIO_SECRET_NAMES },
      caller,
    );
    expect(result.injected).toBe(false);
    const count = await secretsDb
      .selectFrom("tenant_secrets")
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it("rotating the code's key updates what later redemptions inject", async () => {
    await M().createInviteCode(
      undefined,
      { code: "rot", anthropicApiKey: "sk-ant-OLD" },
      admin,
    );
    await M().setInviteCodeAnthropicKey(
      undefined,
      { code: "rot", anthropicApiKey: "sk-ant-NEW" },
      admin,
    );
    await M().redeemInviteCode(undefined, { code: "rot" }, caller);
    await M().applyInviteCodeSecret(
      undefined,
      { tenantId: TENANT, secretNames: ["ANTHROPIC_API_KEY"] },
      caller,
    );
    const s = await secretsDb
      .selectFrom("tenant_secrets")
      .select("ciphertext")
      .where("tenantId", "=", TENANT)
      .where("key", "=", "ANTHROPIC_API_KEY")
      .executeTakeFirstOrThrow();
    expect(await transit.decrypt(TENANT, s.ciphertext!)).toBe("sk-ant-NEW");
  });
});
