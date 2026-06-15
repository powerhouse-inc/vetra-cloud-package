import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraAccessCodesDB } from "../db/schema.js";
import { redeemCode } from "../db/codes.js";
import { createResolvers } from "../resolvers.js";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import type { SecretsService } from "../../vetra-cloud-secrets/services/secrets-service.js";

let db: Kysely<VetraAccessCodesDB>;

const ADDR = "0x" + "a".repeat(40);
const DID = `did:pkh:eip155:1:${ADDR}`;

// Reversible sentinel encryption: ciphertext = `enc:<tenant>:<plaintext>`.
const mockTransit: OpenBaoTransitClient = {
  authenticate: vi.fn(),
  ensureTenantKey: vi.fn().mockResolvedValue(undefined),
  keyFor: vi.fn((t: string) => `vetra-tenant-${t}`),
  encrypt: vi.fn(async (t: string, p: string) => `enc:${t}:${p}`),
  decrypt: vi.fn(async (_t: string, c: string) => c.replace(/^enc:[^:]+:/, "")),
} as unknown as OpenBaoTransitClient;

const setSecret = vi.fn(async (_t: string, key: string) => ({ key }));
const mockSecretsService = {
  setSecret,
} as unknown as SecretsService;

let resolvers: ReturnType<typeof createResolvers>;

const adminCtx = {
  user: { address: ADDR, chainId: 1, networkId: "eip155" },
  isAdmin: () => true,
};
const callerCtx = {
  user: { address: ADDR, chainId: 1, networkId: "eip155" },
  isAdmin: () => false,
};
const anonCtx = {};

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<VetraAccessCodesDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  vi.clearAllMocks();
  resolvers = createResolvers(db, {
    transit: mockTransit,
    secretsService: mockSecretsService,
  });
});

afterEach(async () => {
  await db.destroy();
});

const mut = () => resolvers.VetraAccessCodesMutations;

describe("createInviteCode with attached key", () => {
  it("encrypts the key at rest and reports hasAnthropicKey", async () => {
    const view = await mut().createInviteCode(
      undefined,
      { code: "keyed", anthropicApiKey: "sk-ant-secret" },
      adminCtx,
    );
    expect(view.hasAnthropicKey).toBe(true);
    expect(mockTransit.encrypt).toHaveBeenCalledWith(
      "access-codes",
      "sk-ant-secret",
    );
  });

  it("stores no key when none is given", async () => {
    const view = await mut().createInviteCode(
      undefined,
      { code: "plain" },
      adminCtx,
    );
    expect(view.hasAnthropicKey).toBe(false);
    expect(mockTransit.encrypt).not.toHaveBeenCalled();
  });

  it("is admin-gated", async () => {
    await expect(
      mut().createInviteCode(undefined, { code: "x" }, callerCtx),
    ).rejects.toThrow("FORBIDDEN");
  });
});

describe("setInviteCodeAnthropicKey", () => {
  it("rotates and detaches the key", async () => {
    await mut().createInviteCode(undefined, { code: "c" }, adminCtx);
    expect(
      (
        await mut().setInviteCodeAnthropicKey(
          undefined,
          { code: "c", anthropicApiKey: "sk-ant-1" },
          adminCtx,
        )
      ).hasAnthropicKey,
    ).toBe(true);
    expect(
      (
        await mut().setInviteCodeAnthropicKey(
          undefined,
          { code: "c", anthropicApiKey: null },
          adminCtx,
        )
      ).hasAnthropicKey,
    ).toBe(false);
  });

  it("throws for a missing code and is admin-gated", async () => {
    await expect(
      mut().setInviteCodeAnthropicKey(
        undefined,
        { code: "nope", anthropicApiKey: "x" },
        adminCtx,
      ),
    ).rejects.toThrow("CODE_NOT_FOUND");
    await expect(
      mut().setInviteCodeAnthropicKey(
        undefined,
        { code: "c", anthropicApiKey: "x" },
        callerCtx,
      ),
    ).rejects.toThrow("FORBIDDEN");
  });
});

describe("applyInviteCodeSecret", () => {
  it("writes the decrypted key into the tenant under each secret name", async () => {
    await mut().createInviteCode(
      undefined,
      { code: "keyed", anthropicApiKey: "sk-ant-secret" },
      adminCtx,
    );
    await redeemCode(db, "keyed", DID);

    const result = await mut().applyInviteCodeSecret(
      undefined,
      { tenantId: "tenant-1", secretNames: ["ANTHROPIC_API_KEY", "CLAUDE_KEY"] },
      callerCtx,
    );

    expect(result.injected).toBe(true);
    expect(result.secretNames).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_KEY"]);
    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(setSecret).toHaveBeenCalledWith(
      "tenant-1",
      "ANTHROPIC_API_KEY",
      "sk-ant-secret",
    );
    expect(setSecret).toHaveBeenCalledWith(
      "tenant-1",
      "CLAUDE_KEY",
      "sk-ant-secret",
    );
  });

  it("returns injected=false and writes nothing when the caller has no keyed redemption", async () => {
    await mut().createInviteCode(undefined, { code: "plain" }, adminCtx);
    await redeemCode(db, "plain", DID);

    const result = await mut().applyInviteCodeSecret(
      undefined,
      { tenantId: "tenant-1", secretNames: ["ANTHROPIC_API_KEY"] },
      callerCtx,
    );
    expect(result).toEqual({ injected: false, secretNames: [] });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    await expect(
      mut().applyInviteCodeSecret(
        undefined,
        { tenantId: "t", secretNames: ["X"] },
        anonCtx,
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
});
