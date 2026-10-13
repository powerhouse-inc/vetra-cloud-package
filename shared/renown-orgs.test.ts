import { describe, expect, it, vi } from "vitest";
import {
  MAX_PERSON_APPS,
  RenownSyncGuard,
  TtlLru,
  createRenownOrgs,
  renownOrgsConfigFromEnv,
  RenownOrgsUnavailableError,
} from "./renown-orgs.js";

const ORG = "org-1";
const ALICE = "0xAaAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Answer = { data?: unknown; errors?: { message: string }[] } | Error | { status: number };

function client(answers: Answer[], clock = { t: 0 }) {
  const calls: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    if ("status" in next) return new Response("nope", { status: next.status });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  });
  const orgs = createRenownOrgs({
    orgsEndpoint: "https://renown.test/graphql/renown-orgs",
    statsEndpoint: "https://renown.test/graphql/renown-stats",
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => clock.t,
    logger: { warn: vi.fn() },
  });
  return { orgs, calls, clock };
}

const member = (role = "PUBLISHER", all = true, appDids: string[] = []) => ({
  data: { orgMembership: { role, status: "ACTIVE", effectiveScope: { all, appDids } } },
});

describe("renown orgs client", () => {
  it("asks orgMembership with a lowercased address and caches the answer for 30 s", async () => {
    const { orgs, calls, clock } = client([member(), member("ADMIN")]);
    expect(await orgs.membership(ORG, ALICE)).toStrictEqual({ role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } });
    expect(calls[0].url).toBe("https://renown.test/graphql/renown-orgs");
    expect(calls[0].body.variables).toStrictEqual({ orgId: ORG, address: ALICE.toLowerCase() });
    clock.t = 29_999;
    expect((await orgs.membership(ORG, ALICE.toLowerCase()))?.role).toBe("PUBLISHER");
    expect(calls).toHaveLength(1);
    clock.t = 30_000;
    expect((await orgs.membership(ORG, ALICE))?.role).toBe("ADMIN");
    expect(calls).toHaveLength(2);
  });

  it("caches a missing membership for 10 s only", async () => {
    const { orgs, calls, clock } = client([{ data: { orgMembership: null } }, member()]);
    expect(await orgs.membership(ORG, ALICE)).toBeNull();
    clock.t = 9_999;
    expect(await orgs.membership(ORG, ALICE)).toBeNull();
    clock.t = 10_000;
    expect(await orgs.membership(ORG, ALICE)).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("never caches a failure (network, HTTP status, GraphQL errors)", async () => {
    const { orgs, calls } = client([
      new Error("ECONNREFUSED"),
      { status: 502 },
      { errors: [{ message: "boom" }] },
      member(),
    ]);
    for (let i = 0; i < 3; i++) {
      await expect(orgs.membership(ORG, ALICE)).rejects.toBeInstanceOf(RenownOrgsUnavailableError);
    }
    expect((await orgs.membership(ORG, ALICE))?.role).toBe("PUBLISHER");
    expect(calls).toHaveLength(4);
  });

  it("shares one request between concurrent identical lookups", async () => {
    const { orgs, calls } = client([member()]);
    const [a, b] = await Promise.all([orgs.membership(ORG, ALICE), orgs.membership(ORG, ALICE)]);
    expect(a).toStrictEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("lists an organisation's app DIDs; unknown, archived or taken-down orgs have none", async () => {
    const { orgs } = client([
      { data: { organization: { id: ORG, archived: false, takenDown: false, apps: [{ appDid: "did:key:a" }] } } },
      { data: { organization: null } },
      { data: { organization: { id: "o3", archived: true, takenDown: false, apps: [] } } },
    ]);
    expect(await orgs.orgApps(ORG)).toStrictEqual(["did:key:a"]);
    expect(await orgs.orgApps("o2")).toBeNull();
    expect(await orgs.orgApps("o3")).toBeNull();
  });

  it("reads an app's publisher from renown-stats", async () => {
    const { orgs, calls } = client([
      { data: { appProfile: { publisherDid: "did:web:www.renown.id:org:o1", publisherOrg: { id: "o1" } } } },
      { data: { appProfile: { publisherDid: `did:pkh:eip155:1:${ALICE}`, publisherOrg: null } } },
      { data: { appProfile: null } },
    ]);
    expect(await orgs.appPublisher("did:key:a")).toStrictEqual({ orgId: "o1", address: null });
    expect(calls[0].url).toBe("https://renown.test/graphql/renown-stats");
    expect(await orgs.appPublisher("did:key:b")).toStrictEqual({ orgId: null, address: ALICE.toLowerCase() });
    expect(await orgs.appPublisher("did:key:c")).toBeNull();
  });

  it("evicts the least recently used entry", () => {
    const lru = new TtlLru<number>(2);
    lru.set("a", 1, 1000, 0);
    lru.set("b", 2, 1000, 0);
    expect(lru.get("a", 1)?.value).toBe(1);
    lru.set("c", 3, 1000, 0);
    expect(lru.get("b", 1)).toBeUndefined();
    expect(lru.get("a", 1)?.value).toBe(1);
    expect(lru.get("a", 1000)).toBeUndefined();
  });

  it("derives both endpoints from RENOWN_SWITCHBOARD_URL unless overridden", () => {
    expect(renownOrgsConfigFromEnv({})).toMatchObject({
      orgsEndpoint: "https://switchboard.renown.vetra.io/graphql/renown-orgs",
      statsEndpoint: "https://switchboard.renown.vetra.io/graphql/renown-stats",
    });
    expect(renownOrgsConfigFromEnv({ RENOWN_SWITCHBOARD_URL: "https://sb.staging/graphql/" })).toMatchObject({
      orgsEndpoint: "https://sb.staging/graphql/renown-orgs",
    });
    expect(
      renownOrgsConfigFromEnv({ RENOWN_ORGS_ENDPOINT: " https://x/orgs ", RENOWN_STATS_URL: "https://x/stats" }),
    ).toMatchObject({ orgsEndpoint: "https://x/orgs", statsEndpoint: "https://x/stats" });
  });

  it("returns frozen cached values so callers cannot corrupt the cache", async () => {
    const { orgs } = client([member()]);
    const m = await orgs.membership(ORG, ALICE);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m?.effectiveScope.appDids)).toBe(true);
  });

  it("treats a non-ACTIVE membership as none", async () => {
    const { orgs } = client([
      { data: { orgMembership: { role: "ADMIN", status: "INVITED", effectiveScope: { all: true, appDids: [] } } } },
    ]);
    expect(await orgs.membership(ORG, ALICE)).toBeNull();
  });

  it("fails closed when the request times out", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const orgs = createRenownOrgs({
      orgsEndpoint: "https://r/o",
      statsEndpoint: "https://r/s",
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
      logger: { warn: vi.fn() },
    });
    await expect(orgs.membership(ORG, ALICE)).rejects.toBeInstanceOf(RenownOrgsUnavailableError);
  });

  it("wires maxEntries into the cache", async () => {
    const spy = vi.fn();
    const counted = createRenownOrgs({
      orgsEndpoint: "https://r/o",
      statsEndpoint: "https://r/s",
      maxEntries: 1,
      now: () => 0,
      logger: { warn: vi.fn() },
      fetch: (async () => {
        spy();
        return new Response(JSON.stringify(member()), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await counted.membership("o1", ALICE);
    await counted.membership("o2", ALICE);
    await counted.membership("o1", ALICE);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("person apps", () => {
  it("asks appProfilesByPublisher with the person's did:pkh, bounded and cached", async () => {
    const many = Array.from({ length: MAX_PERSON_APPS + 5 }, (_, i) => ({ appDid: `did:key:${i}` }));
    const { orgs, calls } = client([{ data: { appProfilesByPublisher: many } }, { data: { appProfilesByPublisher: null } }]);
    const dids = await orgs.personApps(ALICE);
    expect(dids).toHaveLength(MAX_PERSON_APPS);
    expect(calls[0].url).toBe("https://renown.test/graphql/renown-stats");
    expect(calls[0].body.variables).toStrictEqual({ publisherDid: `did:pkh:eip155:1:${ALICE.toLowerCase()}` });
    expect(await orgs.personApps(ALICE.toLowerCase())).toBe(dids);
    expect(await orgs.personApps("0xb")).toStrictEqual([]);
  });
});

describe("RenownSyncGuard", () => {
  it("cuts a lookup off after the timeout and then skips Renown for the cool-down", async () => {
    const guard = new RenownSyncGuard({ timeoutMs: 20, cooldownMs: 1_000 });
    expect(guard.timeoutMs).toBe(20);
    expect(await guard.run(async () => 1, 0)).toBe(1);
    await expect(guard.run(() => new Promise<never>(() => {}), 10, undefined, "hung")).rejects.toBeInstanceOf(RenownOrgsUnavailableError);
    const load = vi.fn(async () => 2);
    await expect(guard.run(load, 500, undefined, "x")).rejects.toThrow("lookup skipped");
    expect(load).not.toHaveBeenCalled();
    expect(await guard.run(load, 1_011)).toBe(2);
    // A failing lookup opens it too; a per-call timeout overrides the default.
    await expect(guard.run(async () => Promise.reject(new Error("x")), 2_000)).rejects.toThrow("x");
    await expect(guard.run(load, 2_500)).rejects.toThrow("lookup skipped");
    await expect(guard.run(() => new Promise<never>(() => {}), 5_000, 5)).rejects.toThrow("within 5 ms");
    expect(new RenownSyncGuard().cooldownMs).toBe(10_000);
  });

  it("a slow-but-up Renown still converges: a lookup in the cool-down gets the late answer", async () => {
    const guard = new RenownSyncGuard({ timeoutMs: 20, cooldownMs: 1_000 });
    const slow = () => new Promise<number>((r) => setTimeout(() => r(7), 50));
    const never = vi.fn(async () => 8);
    await expect(guard.run(slow, 0, undefined, "k")).rejects.toThrow("no answer");
    // Still in flight inside the cool-down: skipped, not waited for again.
    await expect(guard.run(never, 10, 100, "k")).rejects.toThrow("skipped");
    expect(never).not.toHaveBeenCalled();
    // Answered earlier: served from the guard during the cool-down.
    await expect(guard.run(slow, 100, undefined, "j")).rejects.toThrow("skipped");
    await new Promise((r) => setTimeout(r, 70));
    expect(await guard.run(never, 200, undefined, "k")).toBe(7);
    // A different key has no answer, so the cool-down still skips it.
    await expect(guard.run(never, 300, undefined, "other")).rejects.toThrow("skipped");
    // Past the cool-down it asks again.
    expect(await guard.run(never, 1_100, undefined, "k")).toBe(8);
  });

  it("evicts settled answers once they expire, even for keys not read again", async () => {
    const guard = new RenownSyncGuard({ answerTtlMs: 100 });
    for (let i = 0; i < 100; i++) await guard.run(async () => i, 0, undefined, `k${i}`);
    expect(guard.size).toBe(100);
    await guard.run(async () => 0, 1_000, undefined, "fresh");
    expect(guard.size).toBeLessThan(5);
  });
});
