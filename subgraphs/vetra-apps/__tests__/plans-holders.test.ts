import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { makeHarness, type Harness } from "./harness.js";
import { seedLicence, seedLicensedEnvironment } from "./instances-fixtures.js";
import {
  chainKinds,
  hasLicensedEnvironments,
  licensedRoots,
  liveChains,
  liveKindsOfHolder,
} from "../plans/holders.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const NOW = "2026-11-12T00:00:00.000Z";
let h: Harness;
let lic: Kysely<VetraLicensingDB>;

beforeEach(async () => {
  h = await makeHarness();
  lic = h.deps.licensingDb!;
});
afterEach(async () => {
  await h.close();
});

describe("plan holders", () => {
  it("lists one live head per chain: renewals keep the root, ended and expired-by-date licences drop out", async () => {
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l1",
      status: "REPLACED",
    });
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l2",
      root: "l1",
    });
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: B,
      licenseId: "l3",
      endAt: "2026-11-01T00:00:00.000Z",
    });
    await seedLicence(h, {
      appId: "other",
      kind: "pro",
      holder: B,
      licenseId: "l4",
    });
    const live = await liveChains(lic, "app", NOW);
    expect([...live.keys()]).toEqual(["l1"]);
    expect(live.get("l1")).toEqual({
      root: "l1",
      licenseId: "l2",
      kind: "pro",
      address: A,
      endAt: null,
    });
  });

  it("knows licensed roots and a holder's live kinds", async () => {
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l1",
    });
    await seedLicence(h, {
      appId: "app",
      kind: null,
      holder: A,
      licenseId: "l2",
    });
    expect(await hasLicensedEnvironments(lic, "app")).toBe(false);
    await seedLicensedEnvironment(h, { appId: "app", root: "l1" });
    expect(await hasLicensedEnvironments(lic, "app")).toBe(true);
    expect([...(await licensedRoots(lic, "app"))]).toEqual(["l1"]);
    expect(await liveKindsOfHolder(lic, A, NOW)).toEqual([
      { appId: "app", kind: "pro" },
    ]);
  });

  it("picks the newest live grant of a chain by created_at, not by insertion order", async () => {
    await seedLicence(h, {
      appId: "app",
      kind: "max",
      holder: A,
      licenseId: "l2",
      root: "l1",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l1",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const live = await liveChains(lic, "app", NOW);
    expect([...live.keys()]).toEqual(["l1"]);
    expect(live.get("l1")).toMatchObject({ licenseId: "l2", kind: "max" });
  });

  it("takes a licence without a chain row as its own root", async () => {
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A.toUpperCase().replace("0X", "0x"),
      licenseId: "solo",
      noChain: true,
    });
    expect(await liveChains(lic, "app", NOW)).toEqual(
      new Map([
        [
          "solo",
          {
            root: "solo",
            licenseId: "solo",
            kind: "pro",
            address: A,
            endAt: null,
          },
        ],
      ]),
    );
  });

  it.each([
    ["REVOKED", {}, false],
    ["EXPIRED", {}, false],
    ["ISSUED", {}, false],
    ["REPLACED", {}, false],
    ["ACTIVE", { endAt: "2027-01-01T00:00:00.000Z" }, true],
    ["ACTIVE", { endAt: NOW }, false],
    ["ACTIVE", { endAt: "not a date" }, false],
    ["ACTIVE", { kind: null }, true],
    ["ACTIVE", { noLifecycle: true }, false],
  ] as const)("a %s licence %j is live: %s", async (status, over, live) => {
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l1",
      status,
      ...over,
    });
    expect((await liveChains(lic, "app", NOW)).has("l1")).toBe(live);
    expect((await liveKindsOfHolder(lic, A, NOW)).length).toBe(
      live && !("kind" in over) ? 1 : 0,
    );
  });

  it("lists a holder's live kinds once per (App, kind), whatever the address case", async () => {
    const seed = (
      licenseId: string,
      appId: string,
      kind: string,
      status = "ACTIVE",
    ) => seedLicence(h, { appId, kind, holder: A, licenseId, status });
    await seed("l1", "app", "pro");
    await seed("l2", "app", "pro");
    await seed("l3", "app", "max", "EXPIRED");
    await seed("l4", "other", "pro");
    await seedLicence(h, {
      appId: "app",
      kind: "max",
      holder: B,
      licenseId: "l5",
    });
    expect(
      await liveKindsOfHolder(lic, A.toUpperCase().replace("0X", "0x"), NOW),
    ).toEqual([
      { appId: "app", kind: "pro" },
      { appId: "other", kind: "pro" },
    ]);
    expect(await liveKindsOfHolder(lic, B, NOW)).toEqual([
      { appId: "app", kind: "max" },
    ]);
  });

  it("counts a chain whose licensed environment ended as licensed (the row is still there)", async () => {
    await seedLicensedEnvironment(h, {
      appId: "app",
      root: "l1",
      endedAt: "2026-11-01T00:00:00.000Z",
    });
    expect([...(await licensedRoots(lic, "app"))]).toEqual(["l1"]);
    expect(await hasLicensedEnvironments(lic, "app")).toBe(true);
  });

  it("reads the kinds of the asked chains only, oldest first", async () => {
    await seedLicence(h, {
      appId: "app",
      kind: "pro",
      holder: A,
      licenseId: "l1",
      status: "REPLACED",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await seedLicence(h, {
      appId: "app",
      kind: null,
      holder: A,
      licenseId: "l2",
      root: "l1",
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    await seedLicence(h, {
      appId: "app",
      kind: "max",
      holder: B,
      licenseId: "l3",
    });
    expect(await chainKinds(lic, "app", ["l1"])).toEqual(
      new Map([
        [
          "l1",
          [
            { licenseId: "l1", kind: "pro" },
            { licenseId: "l2", kind: null },
          ],
        ],
      ]),
    );
    expect(await chainKinds(lic, "app", [])).toEqual(new Map());
  });
});
