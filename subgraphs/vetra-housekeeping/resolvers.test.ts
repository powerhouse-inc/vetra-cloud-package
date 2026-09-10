import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createResolvers, type HousekeepingDeps, type StudioCandidate } from "./resolvers.js";

const INTERNAL_KEY = "test-internal-key";

const candidate: StudioCandidate = {
  host: "a.vetra.io",
  subdomain: "a",
  envId: "e1",
  owner: "0x1",
  status: "READY",
  poolState: "CLAIMED",
  tenantId: "t1",
  services: "[]",
};

/** Full HousekeepingDeps with no-op defaults; pass only what a test needs. */
function makeDeps(overrides: Partial<HousekeepingDeps>): HousekeepingDeps {
  return {
    powerState: async () => {
      throw new Error("not implemented");
    },
    sleep: async () => {
      throw new Error("not implemented");
    },
    wake: async () => {
      throw new Error("not implemented");
    },
    studioActivity: async () => [],
    readyStudios: async () => [],
    ...overrides,
  };
}

/** Context carrying a valid internal-service key (external-detector caller). */
function ctxWithKey() {
  return { internalKey: INTERNAL_KEY };
}

/** Context with neither an internal key nor an admin user. */
function ctxNoAuth() {
  return {};
}

describe("readyStudios", () => {
  const prevInternalKey = process.env.HOUSEKEEPING_INTERNAL_KEY;
  const prevAdmins = process.env.ADMINS;

  beforeEach(() => {
    process.env.HOUSEKEEPING_INTERNAL_KEY = INTERNAL_KEY;
    process.env.ADMINS = "";
  });

  afterEach(() => {
    process.env.HOUSEKEEPING_INTERNAL_KEY = prevInternalKey;
    process.env.ADMINS = prevAdmins;
  });

  test("readyStudios returns candidate rows with valid internal key", async () => {
    const deps = makeDeps({ readyStudios: async () => [candidate] });
    const r = createResolvers(deps);
    const out = await r.VetraHousekeepingQueries.readyStudios({}, {}, ctxWithKey());
    expect(out[0].envId).toBe("e1");
  });

  test("readyStudios FORBIDDEN without internal key or admin", async () => {
    const r = createResolvers(makeDeps({}));
    await expect(
      r.VetraHousekeepingQueries.readyStudios({}, {}, ctxNoAuth()),
    ).rejects.toThrow("FORBIDDEN");
  });

  test("readyStudios FORBIDDEN when the internal key doesn't match", async () => {
    const r = createResolvers(makeDeps({}));
    await expect(
      r.VetraHousekeepingQueries.readyStudios({}, {}, { internalKey: "wrong" }),
    ).rejects.toThrow("FORBIDDEN");
  });

  test("readyStudios allows an admin caller with no internal key", async () => {
    process.env.ADMINS = "0xadmin";
    const deps = makeDeps({ readyStudios: async () => [candidate] });
    const r = createResolvers(deps);
    const out = await r.VetraHousekeepingQueries.readyStudios(
      {},
      {},
      { user: { address: "0xadmin", chainId: 1, networkId: "1" } },
    );
    expect(out[0].envId).toBe("e1");
  });

  test("readyStudios reads the internal key from the raw request header when ctx.internalKey is absent", async () => {
    const deps = makeDeps({ readyStudios: async () => [candidate] });
    const r = createResolvers(deps);
    const out = await r.VetraHousekeepingQueries.readyStudios(
      {},
      {},
      { headers: { "x-housekeeping-key": INTERNAL_KEY } },
    );
    expect(out[0].envId).toBe("e1");
  });
});

describe("sleepStudio", () => {
  const prevInternalKey = process.env.HOUSEKEEPING_INTERNAL_KEY;
  const prevAdmins = process.env.ADMINS;

  beforeEach(() => {
    process.env.HOUSEKEEPING_INTERNAL_KEY = INTERNAL_KEY;
    process.env.ADMINS = "";
  });

  afterEach(() => {
    process.env.HOUSEKEEPING_INTERNAL_KEY = prevInternalKey;
    process.env.ADMINS = prevAdmins;
  });

  test("sleepStudio allowed by internal key without admin", async () => {
    const deps = makeDeps({ sleep: async (h) => ({ host: h, envId: "e", subdomain: "s", owner: "0x1", status: "SLEEPING" }) });
    const r = createResolvers(deps);
    const out = await r.VetraHousekeepingMutations.sleepStudio({}, { host: "s.vetra.io" }, ctxWithKey());
    expect(out.status).toBe("SLEEPING");
  });

  test("sleepStudio FORBIDDEN with no admin and no key", async () => {
    const r = createResolvers(makeDeps({}));
    await expect(r.VetraHousekeepingMutations.sleepStudio({}, { host: "s.vetra.io" }, ctxNoAuth())).rejects.toThrow("FORBIDDEN");
  });
});
