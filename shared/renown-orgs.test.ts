import { describe, expect, it, vi } from "vitest";
import {
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
});
