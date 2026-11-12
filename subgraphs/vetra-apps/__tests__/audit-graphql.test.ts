import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  STRANGER,
  testConfig,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { createResolvers } from "../resolvers.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
});
afterEach(async () => {
  await h.close();
});

const ctx = (address: string, headers: Record<string, string> = {}) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers,
});
const CONSOLE = { origin: "https://vetra.io" };

describe("audit and roles over GraphQL", () => {
  it("audits the console by its Origin and any other client as api", async () => {
    const r = createResolvers(h.deps);
    const p = await r.Mutation.createPlan(
      null,
      { input: { appId, kind: "pro", access: "own" } },
      ctx(OWNER, CONSOLE),
    );
    await r.Mutation.retirePlan(null, { planId: p.id }, ctx(OWNER));
    const page = await r.Query.appAudit(
      null,
      { appId, limit: 10, before: null },
      ctx(OWNER),
    );
    expect(page.entries.map((e) => [e.action, e.source])).toEqual([
      ["plan.retired", "api"],
      ["plan.created", "console"],
    ]);
    expect(page.nextBefore).toBeNull();
  });

  it("audits settings mutations with their source", async () => {
    const r = createResolvers(h.deps);
    await r.Mutation.setAppSetting(
      null,
      {
        input: {
          appId,
          name: "FOO",
          value: "bar",
          secret: false,
          scope: "ALL",
        },
      },
      ctx(OWNER, CONSOLE),
    );
    await r.Mutation.deleteAppSetting(
      null,
      { appId, name: "FOO", scope: "ALL" },
      ctx(OWNER, { origin: "https://evil.example" }),
    );
    const page = await r.Query.appAudit(null, { appId }, ctx(OWNER));
    expect(page.entries.map((e) => [e.action, e.source])).toEqual([
      ["setting.deleted", "api"],
      ["setting.set", "console"],
    ]);
  });

  it("never grants anything for coming from the console", async () => {
    const r = createResolvers(h.deps);
    const forbidden = { extensions: { code: "FORBIDDEN" } };
    await expect(
      r.Mutation.createPlan(
        null,
        { input: { appId, kind: "pro", access: "own" } },
        ctx(STRANGER, CONSOLE),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      r.Mutation.setAppRole(
        null,
        { appId, address: STRANGER, role: null },
        ctx(STRANGER, CONSOLE),
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      r.Query.appAudit(null, { appId }, ctx(STRANGER, CONSOLE)),
    ).rejects.toMatchObject(forbidden);
    expect(await r.Query.appAudit(null, { appId }, ctx(OWNER))).toEqual({
      entries: [],
      nextBefore: null,
    });
  });

  it("names, lists and removes a release manager, and tells each caller what they may do", async () => {
    const r = createResolvers(h.deps);
    expect(
      await r.Mutation.setAppRole(
        null,
        { appId, address: STRANGER, role: null },
        ctx(OWNER),
      ),
    ).toMatchObject({ address: STRANGER, role: "release_manager" });
    expect(
      (await r.Query.appRoles(null, { appId }, ctx(STRANGER))).map(
        (x) => x.address,
      ),
    ).toEqual([STRANGER]);
    expect(await r.Query.appAccess(null, { appId }, ctx(STRANGER))).toEqual({
      operate: false,
      release: true,
      administer: false,
      releaseManager: true,
    });
    await expect(
      r.Mutation.setAppRole(
        null,
        { appId, address: OWNER, role: null },
        ctx(STRANGER),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(
      await r.Mutation.removeAppRole(
        null,
        { appId, address: STRANGER, role: null },
        ctx(OWNER),
      ),
    ).toBe(true);
    const page = await r.Query.appAudit(null, { appId }, ctx(OWNER));
    expect(page.entries.map((e) => [e.action, e.source])).toEqual([
      ["role.removed", "api"],
      ["role.granted", "api"],
    ]);
  });
});
