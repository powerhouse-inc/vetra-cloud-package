import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphQLError } from "graphql";
import { createSubscriptionResolvers, STUDIO_KEY_SECRET_NAMES, type SubscriptionDeps } from "../subscriptions-resolvers.js";
import type { AuthorisedLicence } from "../licence-view.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${HOLDER}`;
const OTHER = "0x2222222222222222222222222222222222222222";
const NOW = "2026-10-08T00:00:00.000Z";
const asHolder = { user: { address: HOLDER } };

const licence: AuthorisedLicence = {
  id: "lic", app: "studio", appId: "studio", user: DID, userDid: DID, kind: "early", issuer: "INVITE_CODE",
  status: "ACTIVE", issued: NOW, start: NOW, end: null, stage: null, details: null, replacedBy: null,
  legacyLicenseTypeId: null, endedAt: null,
};

type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;

/** Only what applyStudioKey reaches is real; the rest throws if touched. */
function build(tenantOwners: SubscriptionDeps["tenantOwners"], over: { hasKey?: boolean } = {}) {
  const setSecret = vi.fn(async (_t: string, key: string, _v: string) => ({ key }));
  const deps = {
    studio: {
      studioAppId: async () => "studio",
      licencesOf: async () => [licence],
      redeemedCode: async () => "code-with-key",
      keyCiphertextForCode: async () => ((over.hasKey ?? true) ? "enc:sk-ant" : null),
      keyVault: { encrypt: async (p: string) => `enc:${p}`, decrypt: async (c: string) => c.slice(4) },
      now: () => NOW,
    },
    secrets: { setSecret },
    tenantOwners: vi.fn(tenantOwners),
    tenantWait: { timeoutMs: 10_000, intervalMs: 500 },
    now: () => NOW,
  } as unknown as SubscriptionDeps;
  const r = createSubscriptionResolvers(deps) as { VetraSubscriptionsMutations: Record<string, Field> };
  const apply = (tenantId: string, secretNames: string[] = ["ANTHROPIC_API_KEY"]) =>
    r.VetraSubscriptionsMutations.applyStudioKey!({}, { tenantId, secretNames }, asHolder);
  return { apply, setSecret, deps };
}

/** Settles a call that polls on (fake) timers; returns its GraphQL code or "OK". */
async function settle(p: Promise<unknown>, advanceMs: number): Promise<unknown> {
  const outcome = p.then(
    () => "OK",
    (e: unknown) => (e as GraphQLError).extensions?.code ?? `UNMAPPED: ${String(e)}`,
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

describe("applyStudioKey: the tenant must be projected and the caller's", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows exactly the studio key names", () => {
    expect(STUDIO_KEY_SECRET_NAMES).toStrictEqual(["ANTHROPIC_API_KEY", "VETRA_ANTHROPIC_API_KEY", "VETRA_CLI_ANTHROPIC_API_KEY"]);
  });

  it("waits for a tenant the projection learns of after a delay, then writes the key", async () => {
    let calls = 0;
    const { apply, setSecret, deps } = build(async () => (++calls < 4 ? [] : [HOLDER]));
    expect(await settle(apply("t-1", [...STUDIO_KEY_SECRET_NAMES]), 2_000)).toBe("OK");
    expect(deps.tenantOwners).toHaveBeenCalledTimes(4);
    for (const name of STUDIO_KEY_SECRET_NAMES) expect(setSecret).toHaveBeenCalledWith("t-1", name, "sk-ant");
    expect(setSecret).toHaveBeenCalledWith("t-1", "VETRA_SESSION_EXPORT_SECRET", expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("gives up after the window: NOT_FOUND, nothing written", async () => {
    const { apply, setSecret, deps } = build(async () => []);
    expect(await settle(apply("t-never"), 10_500)).toBe("NOT_FOUND");
    // One look at t=0 and one every 500 ms up to 10 s.
    expect(deps.tenantOwners).toHaveBeenCalledTimes(21);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["another owner's", [OTHER]],
    ["an unowned", [null]],
    ["a shared (mixed owners)", [HOLDER, OTHER]],
  ])("refuses %s tenant: FORBIDDEN, nothing written", async (_n, owners) => {
    const { apply, setSecret } = build(async () => owners);
    expect(await settle(apply("t-theirs"), 0)).toBe("FORBIDDEN");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("fails closed when the projection table does not exist", async () => {
    const { apply, setSecret, deps } = build(async () => {
      throw Object.assign(new Error('relation "environments" does not exist'), { code: "42P01" });
    });
    expect(await settle(apply("t-1"), 10_500)).toBe("FORBIDDEN");
    expect(deps.tenantOwners).toHaveBeenCalledTimes(1);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("masks any other projection failure as INTERNAL, writing nothing", async () => {
    const { apply, setSecret } = build(async () => {
      throw new Error("db down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await settle(apply("t-1"), 0)).toBe("INTERNAL");
      expect(error).toHaveBeenCalledWith("[licensing] internal error: Error: db down");
    } finally {
      error.mockRestore();
    }
    expect(setSecret).not.toHaveBeenCalled();
  });

  it.each([[["CLAUDE_KEY"]], [["ANTHROPIC_API_KEY", "VETRA_SESSION_EXPORT_SECRET"]], [["anthropic_api_key"]]])(
    "refuses a secret name off the list (%j): INVALID_INPUT, before anything is looked up",
    async (names) => {
      const { apply, setSecret, deps } = build(async () => [HOLDER]);
      expect(await settle(apply("t-1", names), 0)).toBe("INVALID_INPUT");
      expect(deps.tenantOwners).not.toHaveBeenCalled();
      expect(setSecret).not.toHaveBeenCalled();
    },
  );

  it("a caller without a key gets false without the tenant being looked up", async () => {
    const { apply, deps } = build(async () => [HOLDER], { hasKey: false });
    expect(await apply("t-1")).toBe(false);
    expect(deps.tenantOwners).not.toHaveBeenCalled();
  });
});
