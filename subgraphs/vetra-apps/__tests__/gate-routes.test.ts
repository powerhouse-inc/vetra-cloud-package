import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateCounters, TokenBucket } from "../gate/limit.js";
import { createGateRoutes } from "../gate/routes.js";
import { ensureGateToken } from "../gate/service.js";
import { newGateToken } from "../gate/token.js";
import { gateHarness, plan, syncPlans } from "./gate-fixtures.js";
import { fakeVault, type Harness } from "./harness.js";
import { seedLicence } from "./instances-fixtures.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const STRANGE = "0x2222222222222222222222222222222222222222";
let h: Harness;
let appId: string;
let instanceId: string;
let token: string;

beforeEach(async () => {
  ({ h, appId } = await gateHarness());
  await plan(h, appId);
  const row = (await syncPlans(h, appId)).find((r) => r.kind === "shared")!;
  instanceId = row.id;
  token = await fakeVault().decrypt(
    (await ensureGateToken(h.deps, row)).token_ciphertext,
  );
  await seedLicence(h, {
    appId,
    kind: "starter",
    holder: HOLDER,
    licenseId: "l1",
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const post = (
  t: string | null,
  body: unknown,
  raw = false,
  forwardedFor?: string,
) =>
  new Request(
    "https://x/api/@powerhousedao/vetra-cloud-package/apps/gate/check",
    {
      method: "POST",
      headers: {
        ...(t === null ? {} : { authorization: `Bearer ${t}` }),
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        "content-type": "application/json",
      },
      body: raw ? (body as string) : JSON.stringify(body),
    },
  );
const logged = () =>
  JSON.stringify([
    (h.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls,
    (h.deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    (h.deps.logger.error as ReturnType<typeof vi.fn>).mock.calls,
  ]);

describe("POST apps/gate/check", () => {
  it("answers a holder, uncached", async () => {
    const res = await createGateRoutes(h.deps).check(
      post(token, { address: HOLDER }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      allowed: true,
      reason: "licence",
      until: null,
      ttlSeconds: 60,
    });
  });

  it("says the same for a missing and a wrong token", async () => {
    const gate = createGateRoutes(h.deps);
    for (const t of [null, newGateToken(), "abc", `${token}x`]) {
      const res = await gate.check(post(t, { address: HOLDER }));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: "UNAUTHENTICATED",
        message: "Invalid gate token",
      });
    }
  });

  it("refuses bad bodies and addresses with 400", async () => {
    const gate = createGateRoutes(h.deps);
    for (const req of [
      post(token, "not json", true),
      post(token, {}),
      post(token, null),
      post(token, { address: "0x123" }),
      post(token, { address: `did:pkh:eip155:1:${HOLDER}` }),
      post(token, { address: 42 }),
    ]) {
      const res = await gate.check(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("BAD_USER_INPUT");
    }
  });

  it("limits each instance: 429 with Retry-After", async () => {
    const gate = createGateRoutes(h.deps, {
      perInstance: new TokenBucket(1, 2),
    });
    expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
      200,
    );
    expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
      200,
    );
    const res = await gate.check(post(token, { address: HOLDER }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await res.json()).error).toBe("RATE_LIMITED");
  });

  it("limits unknown tokens globally, before any database read", async () => {
    const gate = createGateRoutes(h.deps, { badTokens: new TokenBucket(1, 1) });
    // A known token goes on working (and is remembered as verified).
    expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
      200,
    );
    expect(
      (await gate.check(post(newGateToken(), { address: HOLDER }))).status,
    ).toBe(401);
    const spy = vi.spyOn(h.db, "selectFrom");
    const res = await gate.check(post(newGateToken(), { address: HOLDER }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await gate.check(post("abc", { address: HOLDER }))).status).toBe(
      429,
    );
    expect(spy).not.toHaveBeenCalled();
    expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
      200,
    );
  });

  it("keys unknown tokens by client address: a flood never blocks a known host", async () => {
    const gate = createGateRoutes(h.deps, { badTokens: new TokenBucket(1, 2) });
    const ATTACKER = "203.0.113.7";
    const HOST = "10.0.0.5";
    for (let i = 0; i < 20; i++)
      await gate.check(
        post(newGateToken(), { address: HOLDER }, false, ATTACKER),
      );
    expect(
      (
        await gate.check(
          post(newGateToken(), { address: HOLDER }, false, ATTACKER),
        )
      ).status,
    ).toBe(429);
    // A client-written entry before the proxy's own does not move the key.
    expect(
      (
        await gate.check(
          post(
            newGateToken(),
            { address: HOLDER },
            false,
            `${HOST}, ${ATTACKER}`,
          ),
        )
      ).status,
    ).toBe(429);
    // The host (first check, not yet verified) still has its own bucket.
    expect(
      (await gate.check(post(token, { address: HOLDER }, false, HOST))).status,
    ).toBe(200);
  });

  it("slides the verified window: a host checking past 5 minutes still passes an empty bucket", async () => {
    const start = Date.now();
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gate = createGateRoutes(h.deps, {
      badTokens: new TokenBucket(0, 1, 10, () => now),
    });
    expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
      200,
    );
    // An attacker on the same (global) key empties the bucket for good.
    await gate.check(post(newGateToken(), { address: HOLDER }));
    expect(
      (await gate.check(post(newGateToken(), { address: HOLDER }))).status,
    ).toBe(429);
    for (let i = 0; i < 4; i++) {
      now += 3 * 60_000;
      expect((await gate.check(post(token, { address: HOLDER }))).status).toBe(
        200,
      );
    }
  });

  it("fails with 503 when the licence lookup fails, never logging the token", async () => {
    h.deps.licensingDb = null;
    const res = await createGateRoutes(h.deps).check(
      post(token, { address: HOLDER }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("SERVICE_UNAVAILABLE");
    expect(logged()).toMatch(/gate check failed/);
    expect(logged()).not.toContain(token);
  });

  it("counts, and flushes one line then nothing", async () => {
    const counters = new GateCounters();
    const gate = createGateRoutes(h.deps, { counters });
    await gate.check(post(token, { address: HOLDER }));
    await gate.check(post(token, { address: STRANGE }));
    await gate.check(post(newGateToken(), { address: HOLDER }));
    const line = gate.counters.flush()!;
    expect(line).toContain("checks=2 allowed=1 denied=1 unauthorized=1");
    expect(line).toContain(`${instanceId}:2/1/1`);
    expect(line).not.toContain(token);
    expect(gate.counters.flush()).toBeNull();
  });
});

describe("TokenBucket", () => {
  it("refills continuously and evicts the oldest key over maxKeys", () => {
    let now = 0;
    const b = new TokenBucket(2, 2, 2, () => now);
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
    now = 500; // one token back
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
    b.take("b");
    b.take("c"); // evicts a (least recently used)
    expect(b.size).toBe(2);
    expect(b.take("a")).toBe(true); // a new, full bucket
  });
});
