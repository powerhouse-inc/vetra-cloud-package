import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  appIdentity,
  makeHarness,
  member,
  MEMBER,
  ORG,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import type { Caller } from "../auth.js";
import { appForOwner } from "../service.js";

/**
 * Regression guard for loadAppForOwner's existing levels ("operate", the
 * default, and "view"): who gets in must not change when new levels and
 * per-App roles are added (releases phase 3, plan 2).
 */

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );
const operate = (c: Caller) => code(appForOwner(h.deps, c, appId));
const operateExplicit = (c: Caller) =>
  code(appForOwner(h.deps, c, appId, { need: "operate" }));
const view = (c: Caller) =>
  code(appForOwner(h.deps, c, appId, { need: "view" }));
const both = async (c: Caller) => [
  await operate(c),
  await operateExplicit(c),
  await view(c),
];
const moveToOrg = async () => {
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  await appForOwner(h.deps, admin, appId);
};

describe("existing access levels of a personal App", () => {
  it("owner and platform admins operate and view; others neither", async () => {
    expect(await both(owner)).toEqual(["OK", "OK", "OK"]);
    expect(await both(admin)).toEqual(["OK", "OK", "OK"]);
    expect(await both(stranger)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
    expect(await both(member)).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
  });

  it("refuses the App's own identity (CI) at every level", async () => {
    expect(await both(appIdentity)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
  });

  it("an unknown App is NOT_FOUND", async () => {
    expect(await code(appForOwner(h.deps, owner, "nope"))).toBe("NOT_FOUND");
  });
});

describe("existing access levels of an org App", () => {
  beforeEach(moveToOrg);

  it("OWNER, ADMIN and an in-scope PUBLISHER operate and view", async () => {
    for (const role of ["OWNER", "ADMIN", "PUBLISHER"] as const) {
      h.orgs.join(ORG, MEMBER, role);
      expect(await both(member)).toEqual(["OK", "OK", "OK"]);
    }
    h.orgs.join(ORG, MEMBER, "PUBLISHER", [APP_DID]);
    expect(await both(member)).toEqual(["OK", "OK", "OK"]);
  });

  it("a plain MEMBER and an out-of-scope PUBLISHER only view", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await both(member)).toEqual(["FORBIDDEN", "FORBIDDEN", "OK"]);
    h.orgs.join(ORG, MEMBER, "PUBLISHER", ["did:key:other"]);
    expect(await both(member)).toEqual(["FORBIDDEN", "FORBIDDEN", "OK"]);
  });

  it("the creator who is not a member and strangers get nothing; platform admins everything", async () => {
    expect(await both(owner)).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    expect(await both(stranger)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
    expect(await both(admin)).toEqual(["OK", "OK", "OK"]);
  });

  it("refuses the App's identity even when its address is an org OWNER", async () => {
    h.orgs.join(ORG, appIdentity.address, "OWNER");
    expect(await both(appIdentity)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
  });

  it("a Renown outage refuses members, not platform admins", async () => {
    h.orgs.join(ORG, MEMBER, "OWNER");
    h.orgs.down = true;
    expect(await both(member)).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    expect(await both(admin)).toEqual(["OK", "OK", "OK"]);
  });

  it("a disputed org grants its members nothing", async () => {
    h.orgs.join(ORG, MEMBER, "OWNER");
    h.orgs.publishers.set(APP_DID, { orgId: null, address: null });
    h.clock.now = new Date(h.clock.now.getTime() + 31_000);
    expect(await both(member)).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    expect(await both(admin)).toEqual(["OK", "OK", "OK"]);
  });
});
