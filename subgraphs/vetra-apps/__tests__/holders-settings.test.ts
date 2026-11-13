import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  makeHarness,
  MEMBER,
  owner,
  OWNER,
  seedActiveApp,
  stranger,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan } from "../plans/repo.js";
import { setAppRole } from "../roles/service.js";
import { appSettingsFor, setAppSetting } from "../settings/service.js";
import { listInstanceSettings } from "../settings/holder-repo.js";
import {
  deleteMyInstanceSetting,
  importHolderSettings,
  MAX_HOLDER_SETTINGS,
  myInstanceSettingsFor,
  setMyInstanceSetting,
} from "../settings/holder-service.js";
import { createResolvers } from "../resolvers.js";
import type { Caller } from "../auth.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};
const releaseManager: Caller = {
  address: MEMBER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};

let h: Harness;
let appId: string;
let ownId: string;
let sharedId: string;

const base = {
  policy: "manual",
  notice_hours: 72,
  status: "active" as const,
  size: "VETRA_AGENT_S",
  target_version: "1.4.0",
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  h.deps.holderVault = {
    encrypt: async (p) => `holder:${Buffer.from(p).toString("base64")}`,
    decrypt: async (c) =>
      Buffer.from(c.slice("holder:".length), "base64").toString(),
  };
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
  await insertPlan(h.db, {
    ...base,
    id: "p-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
  });
  await insertPlan(h.db, {
    ...base,
    id: "p-sh",
    app_id: appId,
    slug: "starter",
    name: "Starter",
    kind: "starter",
    access: "shared",
  });
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await seedLicence(h, {
    appId,
    kind: "starter",
    holder: HOLDER,
    licenseId: "l2",
  });
  await reconcileInstancesOnce(h.deps);
  const rows = await listInstances(h.db, appId);
  ownId = rows.find((r) => r.kind === "own")!.id;
  sharedId = rows.find((r) => r.kind === "shared")!.id;
  await setAppRole(h.deps, owner, appId, MEMBER, null);
});
afterEach(async () => {
  await h.close();
});

const set = (
  o: Partial<Parameters<typeof setMyInstanceSetting>[2]> = {},
  who: Caller = holder,
) =>
  setMyInstanceSetting(h.deps, who, {
    instanceId: ownId,
    name: "GOOGLE_CLIENT_ID",
    kind: "PLAIN",
    value: "cid",
    ...o,
  });

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code,
  );

const instanceAudit = () =>
  h.db
    .selectFrom("app_audit")
    .selectAll()
    .where("subject", "like", "instance:%")
    .where("action", "=", "instance.setting.changed")
    .orderBy("at")
    .execute();

describe("holder settings", () => {
  it("the holder sets a plain and a secret setting; the secret is write-only and encrypted", async () => {
    expect(await set()).toMatchObject({
      name: "GOOGLE_CLIENT_ID",
      kind: "PLAIN",
      value: "cid",
    });
    expect(
      await set({
        name: "GOOGLE_CLIENT_SECRET",
        kind: "SECRET",
        value: "s3cret",
      }),
    ).toMatchObject({ kind: "SECRET", value: null });
    const mine = await myInstanceSettingsFor(h.deps, holder, ownId);
    expect(mine.settings.map((s) => [s.name, s.kind, s.value])).toEqual([
      ["GOOGLE_CLIENT_ID", "PLAIN", "cid"],
      ["GOOGLE_CLIENT_SECRET", "SECRET", null],
    ]);
    expect(JSON.stringify(mine)).not.toContain("s3cret");
    const [, secret] = (await listInstanceSettings(h.db, [ownId])).get(ownId)!;
    expect(secret.ciphertext).toMatch(/^holder:/);
    expect(secret.ciphertext).not.toContain("s3cret");
    const logged = JSON.stringify([
      (h.deps.logger.info as any).mock.calls,
      (h.deps.logger.warn as any).mock.calls,
      (h.deps.logger.error as any).mock.calls,
    ]);
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("shows the names the publisher sets on the instance, never their values", async () => {
    await setAppSetting(h.deps, owner, {
      appId,
      name: "GOOGLE_CLIENT_ID",
      value: "publisher-cid",
      secret: false,
      scope: "PLAN",
    });
    await setAppSetting(h.deps, owner, {
      appId,
      name: "BRANCH_ONLY",
      value: "x",
      secret: false,
      scope: "BRANCH",
    });
    const mine = await myInstanceSettingsFor(h.deps, holder, ownId);
    expect(mine.publisherNames).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(JSON.stringify(mine)).not.toContain("publisher-cid");
    expect(mine.reservedNames).toContain("ADMINS");
    expect(mine.reservedPrefixes).toContain("VETRA_");
  });

  it("is holder-only: the App owner, a release manager, a platform admin and a stranger get NOT_FOUND", async () => {
    await set();
    for (const who of [owner, releaseManager, admin, stranger]) {
      expect(await code(myInstanceSettingsFor(h.deps, who, ownId))).toBe(
        "NOT_FOUND",
      );
      expect(await code(set({ value: "x" }, who))).toBe("NOT_FOUND");
      expect(
        await code(
          deleteMyInstanceSetting(h.deps, who, ownId, "GOOGLE_CLIENT_ID"),
        ),
      ).toBe("NOT_FOUND");
    }
    expect(
      (await myInstanceSettingsFor(h.deps, holder, ownId)).settings[0].value,
    ).toBe("cid");
  });

  it("refuses a shared instance, a removed own instance, an unknown id, a deleted App, and while plans are off", async () => {
    expect(await code(set({ instanceId: sharedId }))).toBe("NOT_FOUND");
    expect(await code(set({ instanceId: "nope" }))).toBe("NOT_FOUND");
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", appId)
      .execute();
    expect(await code(set())).toBe("NOT_FOUND");
    await h.db
      .updateTable("apps")
      .set({ status: "ACTIVE" })
      .where("id", "=", appId)
      .execute();
    await h.db
      .updateTable("instances")
      .set({ status: "removed" })
      .where("id", "=", ownId)
      .execute();
    expect(await code(set())).toBe("NOT_FOUND");
    h.deps.cfg = {
      ...h.deps.cfg,
      plans: { enabled: false, stopAfterDays: 14 },
    };
    expect(await code(myInstanceSettingsFor(h.deps, holder, ownId))).toBe(
      "SERVICE_NOT_CONFIGURED",
    );
  });

  it("refuses a CI workload identity like the owner-only paths", async () => {
    expect(await code(set({}, { ...holder, appKey: APP_DID }))).toBe(
      "FORBIDDEN",
    );
  });

  it("refuses reserved names, bad values and the setting after the cap (BAD_USER_INPUT)", async () => {
    for (const o of [
      { name: "ADMINS" },
      { name: "VETRA_X" },
      { name: "PH_HOST" },
      { name: "lower" },
      { name: undefined },
      { kind: "SECRET" as const, value: "" },
      { kind: "NOPE" as never },
    ])
      expect(await code(set(o))).toBe("BAD_USER_INPUT");
    for (let i = 0; i < MAX_HOLDER_SETTINGS; i++)
      await set({ name: `S${i}`, value: "v" });
    expect(await code(set({ name: "ONE_MORE" }))).toBe("BAD_USER_INPUT");
    expect(await code(set({ name: "S0", value: "w" }))).toBe("OK");
  });

  it("deletes a setting; a second delete is false", async () => {
    await set();
    expect(
      await deleteMyInstanceSetting(h.deps, holder, ownId, "GOOGLE_CLIENT_ID"),
    ).toBe(true);
    expect(
      await deleteMyInstanceSetting(h.deps, holder, ownId, "GOOGLE_CLIENT_ID"),
    ).toBe(false);
    expect(
      (await myInstanceSettingsFor(h.deps, holder, ownId)).settings,
    ).toEqual([]);
  });

  it("audits every write without the name or the value (H3)", async () => {
    await set();
    await set({
      name: "GOOGLE_CLIENT_SECRET",
      kind: "SECRET",
      value: "s3cret",
    });
    await set({
      name: "GOOGLE_CLIENT_SECRET",
      kind: "SECRET",
      value: "s3cret2",
    });
    await deleteMyInstanceSetting(h.deps, holder, ownId, "GOOGLE_CLIENT_ID");
    await deleteMyInstanceSetting(h.deps, holder, ownId, "GOOGLE_CLIENT_ID");
    const rows = await instanceAudit();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toMatchObject({
        app_id: appId,
        actor: HOLDER,
        subject: `instance:${ownId}`,
      });
      const s = JSON.stringify(r);
      for (const leak of ["GOOGLE", "cid", "s3cret"])
        expect(s).not.toContain(leak);
    }
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { secret: false, file: false, deleted: false, replaced: false },
      { secret: true, file: false, deleted: false, replaced: false },
      { secret: true, file: false, deleted: false, replaced: true },
      { deleted: true },
    ]);
  });

  it("never shows holder settings in the publisher's appSettings", async () => {
    const before = await appSettingsFor(h.deps, owner, appId);
    await set();
    await set({ name: "GOOGLE_CLIENT_SECRET", kind: "SECRET", value: "s" });
    expect(await appSettingsFor(h.deps, owner, appId)).toEqual(before);
  });
});

describe("importHolderSettings (slice 9, internal)", () => {
  it("stores what passes the checks and skips the rest with a reason", async () => {
    const out = await importHolderSettings(
      h.deps,
      ownId,
      [
        { name: "ADMINS", kind: "PLAIN", value: "0x1" },
        { name: "MODE", kind: "PLAIN", value: "a" },
        { name: "TOKEN", kind: "SECRET", value: "t0ken" },
        { name: "EMPTY", kind: "SECRET", value: "" },
      ],
      "vetra",
    );
    expect(out.stored).toEqual(["MODE", "TOKEN"]);
    expect(out.skipped.map((s) => s.name)).toEqual(["ADMINS", "EMPTY"]);
    for (const s of out.skipped) expect(s.reason).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain("t0ken");
    const mine = await myInstanceSettingsFor(h.deps, holder, ownId);
    expect(mine.settings.map((s) => [s.name, s.value])).toEqual([
      ["MODE", "a"],
      ["TOKEN", null],
    ]);
    const audit = await instanceAudit();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("MODE");
  });

  it("refuses an instance that is not an own instance", async () => {
    expect(
      await code(
        importHolderSettings(
          h.deps,
          sharedId,
          [{ name: "MODE", kind: "PLAIN", value: "a" }],
          "vetra",
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("GraphQL", () => {
  it("wires myInstanceSettings, setMyInstanceSetting and deleteMyInstanceSetting", async () => {
    const r = createResolvers(h.deps) as any;
    const ctx = { user: { address: HOLDER, chainId: 1 } };
    const out = await r.Mutation.setMyInstanceSetting(
      null,
      {
        input: {
          instanceId: ownId,
          name: "MODE",
          kind: "PLAIN",
          value: "a",
        },
      },
      ctx,
    );
    expect(out).toMatchObject({ name: "MODE", kind: "PLAIN", value: "a" });
    expect(
      (await r.Query.myInstanceSettings(null, { instanceId: ownId }, ctx))
        .settings,
    ).toHaveLength(1);
    expect(
      await r.Mutation.deleteMyInstanceSetting(
        null,
        { instanceId: ownId, name: "MODE" },
        ctx,
      ),
    ).toBe(true);
  });
});
