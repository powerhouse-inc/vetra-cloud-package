import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { makeHarness, type Harness } from "./harness.js";
import { seedLicence, seedLicensedEnvironment } from "./instances-fixtures.js";
import {
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
});
