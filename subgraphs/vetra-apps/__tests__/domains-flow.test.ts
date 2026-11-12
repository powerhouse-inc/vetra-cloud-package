import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { domainActions } from "../instances/render.js";
import { insertPlan } from "../plans/repo.js";
import { myInstancesFor } from "../plans/holder-view.js";
import { listAudit } from "../audit/repo.js";
import {
  checkDomainsOnce,
  DNS_NEVER_POINTED,
  ISSUING_WAIT_MS,
  DNS_WAIT_MS,
  moveCustomDomainToInstance,
  NO_CERTIFICATE_YET,
  removeMyInstanceCustomDomain,
  setMyInstanceCustomDomain,
} from "../domains/service.js";
import type { DomainProbe } from "../domains/dns.js";
import { INGRESS_IP } from "../../../document-models/vetra-cloud-environment/v1/src/reducers/utils.js";
import {
  initialize,
  setCustomDomain,
  setOwner,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { Caller } from "../auth.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const SERVICE = "0x9999999999999999999999999999999999999999";
const as = (address: string): Caller => ({
  address,
  chainId: 1,
  appKey: null,
  isAdmin: false,
});
const holder = as(HOLDER);

let h: Harness;
let appId: string;
const dns = new Map<string, string[]>();
const tls = new Map<string, boolean>();
const probe: DomainProbe = {
  a: async (host) => dns.get(host) ?? [],
  tls: async (host) => ({ valid: tls.get(host) ?? false, expiresAt: null }),
};
const envDomains = new Map<string, string>();

const plan = (id: string, kind: string, access: "own" | "shared") => ({
  id,
  app_id: appId,
  slug: kind,
  name: kind,
  kind,
  access,
  size: "VETRA_AGENT_M",
  target_version: "1.4.0",
  policy: "manual",
  notice_hours: 72,
  status: "active" as const,
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
});

beforeEach(async () => {
  dns.clear();
  tls.clear();
  envDomains.clear();
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  h.deps.serviceOwner = SERVICE;
  h.deps.domainProbe = probe;
  h.deps.customDomainUsed = async (d, except) =>
    [...envDomains].some(([env, dom]) => dom === d && env !== except);
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
  await insertPlan(h.db, plan("plan-own", "pro", "own"));
  await insertPlan(h.db, plan("plan-sh", "starter", "shared"));
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await seedLicence(h, { appId, kind: "pro", holder: OTHER, licenseId: "l2" });
  await seedLicence(h, {
    appId,
    kind: "starter",
    holder: HOLDER,
    licenseId: "l3",
  });
  await reconcileInstancesOnce(h.deps);
  for (const r of await listInstances(h.db, appId))
    if (r.environment_id) h.envs.setStatus(r.environment_id, "READY");
  await reconcileInstancesOnce(h.deps);
  expect((await own()).status).toBe("ready");
});
afterEach(async () => {
  await h.close();
});

const own = async (address = HOLDER) =>
  (await listInstances(h.db, appId)).find(
    (r) => r.kind === "own" && r.holder_address === address.toLowerCase(),
  )!;
const shared = async () =>
  (await listInstances(h.db, appId)).find((r) => r.kind === "shared")!;
const env = async () => (await h.envs.getState((await own()).environment_id!))!;
const executedOn = async () => {
  const id = (await own()).environment_id!;
  return h.envs.executed.filter((e) => e.id === id).flatMap((e) => e.types);
};
/** A reconcile pass, then the environment settles READY. */
const settle = async () => {
  await reconcileInstancesOnce(h.deps);
  h.envs.setStatus((await own()).environment_id!, "READY");
  await reconcileInstancesOnce(h.deps);
};

describe("holder custom domains (plan 7 Task 8)", () => {
  it("dns → issuing → applied → active; the URL becomes the domain only once active", async () => {
    const id = (await own()).id;
    const out = await setMyInstanceCustomDomain(
      h.deps,
      holder,
      id,
      "App.Acme.io.",
    );
    expect(out).toMatchObject({ domain: "app.acme.io", status: "DNS" });
    expect(out.records).toEqual([
      { type: "A", host: "app.acme.io", value: INGRESS_IP },
    ]);
    expect(out.alternative).toMatchObject({ type: "CNAME" });

    dns.set("app.acme.io", ["9.9.9.9"]);
    await checkDomainsOnce(h.deps);
    expect(await own()).toMatchObject({ custom_domain_status: "dns" });
    expect((await own()).custom_domain_reason).toContain("9.9.9.9");
    // Not applied while waiting for DNS.
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain?.enabled ?? false).toBe(false);

    dns.set("app.acme.io", [INGRESS_IP]);
    await checkDomainsOnce(h.deps);
    expect((await own()).custom_domain_status).toBe("issuing");
    const before = (await executedOn()).length;
    await reconcileInstancesOnce(h.deps);
    const sent = (await executedOn()).slice(before);
    expect(sent).toContain("SET_CUSTOM_DOMAIN");
    expect(sent).not.toContain("SET_APEX_SERVICE"); // already FUSION
    expect((await env()).customDomain).toMatchObject({
      enabled: true,
      domain: "app.acme.io",
    });
    expect((await own()).status).toBe("updating");
    expect((await myInstancesFor(h.deps, holder))[0].url).not.toBe(
      "https://app.acme.io",
    );

    tls.set("app.acme.io", true);
    await checkDomainsOnce(h.deps);
    expect((await own()).custom_domain_status).toBe("active");
    const mine = (await myInstancesFor(h.deps, holder)).find(
      (m) => m.access === "own",
    )!;
    expect(mine.url).toBe("https://app.acme.io");
    expect(mine.customDomain).toMatchObject({ status: "ACTIVE" });

    const steps = (await listAudit(h.db, appId, { limit: 50 }))
      .filter((r) => r.action === "instance.domain")
      .map((r) => JSON.parse(r.detail).step);
    expect(steps.sort()).toEqual(["active", "applied", "requested"]);
  });

  it("refuses a domain another instance or an environment holds, and Vetra's own", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    await expect(
      setMyInstanceCustomDomain(
        h.deps,
        as(OTHER),
        (await own(OTHER)).id,
        "app.acme.io",
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    envDomains.set("licensed-env", "shop.acme.io");
    await expect(
      setMyInstanceCustomDomain(
        h.deps,
        as(OTHER),
        (await own(OTHER)).id,
        "shop.acme.io",
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      setMyInstanceCustomDomain(
        h.deps,
        as(OTHER),
        (await own(OTHER)).id,
        "x.vetra.io",
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("is holder-only, own instances only (spec 17), and refused while plans are off", async () => {
    await expect(
      setMyInstanceCustomDomain(
        h.deps,
        as(OTHER),
        (await own()).id,
        "a.acme.io",
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await expect(
      setMyInstanceCustomDomain(
        h.deps,
        holder,
        (await shared()).id,
        "a.acme.io",
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    h.deps.cfg = {
      ...h.deps.cfg,
      plans: { enabled: false, stopAfterDays: 14 },
    };
    await expect(
      setMyInstanceCustomDomain(h.deps, holder, (await own()).id, "a.acme.io"),
    ).rejects.toMatchObject({ extensions: { code: "SERVICE_NOT_CONFIGURED" } });
  });

  it("remove → the next reconcile takes the domain off the document", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    dns.set("app.acme.io", [INGRESS_IP]);
    await checkDomainsOnce(h.deps);
    await settle();
    expect((await env()).customDomain?.enabled).toBe(true);
    expect(
      await removeMyInstanceCustomDomain(h.deps, holder, (await own()).id),
    ).toBe(true);
    expect((await own()).custom_domain).toBeNull();
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain).toMatchObject({
      enabled: false,
      domain: null,
    });
  });

  it("repairs drift: a document that lost the domain gets it back", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    dns.set("app.acme.io", [INGRESS_IP]);
    await checkDomainsOnce(h.deps);
    await settle();
    await h.envs.execute((await own()).environment_id!, [
      setCustomDomain({ enabled: false, domain: null }),
    ]);
    h.envs.setStatus((await own()).environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain).toMatchObject({
      enabled: true,
      domain: "app.acme.io",
    });
  });

  it("issuing times out after 60 minutes → failed (still applied); a later valid certificate → active", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    dns.set("app.acme.io", [INGRESS_IP]);
    await checkDomainsOnce(h.deps);
    h.advance(ISSUING_WAIT_MS + 1000);
    await checkDomainsOnce(h.deps);
    expect(await own()).toMatchObject({
      custom_domain_status: "failed",
      custom_domain_reason: NO_CERTIFICATE_YET,
    });
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain?.enabled).toBe(true);
    tls.set("app.acme.io", true);
    await checkDomainsOnce(h.deps);
    expect((await own()).custom_domain_status).toBe("active");
  });

  it("gives up on DNS after 7 days, without ever applying the domain", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    h.advance(DNS_WAIT_MS + 1000);
    await checkDomainsOnce(h.deps);
    expect(await own()).toMatchObject({
      custom_domain_status: "failed",
      custom_domain_reason: DNS_NEVER_POINTED,
    });
    tls.set("app.acme.io", true);
    await checkDomainsOnce(h.deps);
    expect((await own()).custom_domain_status).toBe("failed");
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain?.enabled ?? false).toBe(false);
  });

  it("reports an active domain whose certificate fails three daily checks", async () => {
    await setMyInstanceCustomDomain(
      h.deps,
      holder,
      (await own()).id,
      "app.acme.io",
    );
    dns.set("app.acme.io", [INGRESS_IP]);
    tls.set("app.acme.io", true);
    await checkDomainsOnce(h.deps);
    await checkDomainsOnce(h.deps);
    expect((await own()).custom_domain_status).toBe("active");
    tls.set("app.acme.io", false);
    for (let i = 0; i < 3; i++) {
      h.advance(24 * 3600_000 + 1000);
      await checkDomainsOnce(h.deps);
    }
    expect(await own()).toMatchObject({ custom_domain_status: "active" });
    expect((await own()).custom_domain_reason).toContain("3 daily checks");
  });

  it("moveCustomDomainToInstance: admins only; clears the licensed environment first, then issuing", async () => {
    const from = await h.envs.create();
    await h.envs.execute(from, [
      initialize({
        genericSubdomain: "sektar-frank",
        genericBaseDomain: "vetra.io",
        defaultPackageRegistry: null,
      }),
      setOwner({ address: HOLDER }),
      setCustomDomain({ enabled: true, domain: "frank.sektar.app" }),
    ]);
    const input = { fromEnvironmentId: from, instanceId: (await own()).id };
    await expect(
      moveCustomDomainToInstance(h.deps, holder, input),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    h.envs.setStatus(from, "READY");
    await expect(
      moveCustomDomainToInstance(h.deps, admin, input),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    h.envs.setStatus(from, "STOPPED");
    const out = await moveCustomDomainToInstance(h.deps, admin, input);
    expect(out).toMatchObject({
      domain: "frank.sektar.app",
      status: "ISSUING",
    });
    expect((await h.envs.getState(from))!.customDomain).toMatchObject({
      enabled: false,
      domain: null,
    });
    await reconcileInstancesOnce(h.deps);
    expect((await env()).customDomain).toMatchObject({
      enabled: true,
      domain: "frank.sektar.app",
    });
  });
});

describe("domainActions", () => {
  it("throws on a licensed document and on a PREVIEW document", async () => {
    const state = await env();
    expect(() =>
      domainActions({ ...state, managedBy: "licensing" } as never, "a.acme.io"),
    ).toThrow(/licensed/);
    expect(() =>
      domainActions(
        { ...state, app: { ...state.app!, role: "PREVIEW" } },
        "a.acme.io",
      ),
    ).toThrow(/not a plan instance/);
    expect(domainActions(state, null)).toEqual([]);
  });
});
