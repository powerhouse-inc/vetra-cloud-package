import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { getGateToken } from "../gate/repo.js";
import {
  GATE_PREVIOUS_GRACE_MS,
  rotateInstanceGateToken,
} from "../gate/service.js";
import { hashGateToken } from "../gate/token.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import { listAppSettings } from "../settings/repo.js";
import { settingsForKind } from "../settings/resolve.js";
import { appSettingsFor, setAppSetting } from "../settings/service.js";
import {
  GATE_ACCESS_ENV,
  GATE_APP_ID_ENV,
  GATE_URL_ENV,
  GATE_TOKEN_ENV,
} from "../gate/service.js";
import { GATE_ON, gateHarness, plan, PLANS_ON } from "./gate-fixtures.js";
import { OWNER, owner, stranger, testConfig, type Harness } from "./harness.js";
import { appInstancesFor } from "../instances/service.js";
import { createResolvers } from "../resolvers.js";
import { buildASTSchema, graphql } from "graphql";
import { schema } from "../schema.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await gateHarness());
  await setAppSetting(h.deps, owner, {
    appId,
    name: "RELAY",
    value: "https://relay",
    secret: false,
  });
  await setAppSetting(h.deps, owner, {
    appId,
    name: "API_TOKEN",
    value: "s3cret",
    secret: true,
  });
});
afterEach(async () => {
  await h.close();
});

const byKind = async (kind: InstanceRow["kind"]) =>
  (await listInstances(h.db, appId)).find((r) => r.kind === kind)!;
const shared = () => byKind("shared");
const stateOf = async (row: InstanceRow) =>
  (await h.envs.getState(row.environment_id!))!;
const envOf = async (row: InstanceRow) => (await stateOf(row)).fusion!.env;
const tenantOf = (row: InstanceRow) =>
  getTenantId(row.host!, row.environment_id!);
const tokenRows = () =>
  h.db.selectFrom("instance_gate_tokens").selectAll().execute();
const ready = async () => {
  await reconcileInstancesOnce(h.deps);
  for (const r of await listInstances(h.db, appId))
    if (r.environment_id) h.envs.setStatus(r.environment_id, "READY");
  await reconcileInstancesOnce(h.deps);
};

describe("the licence gate on shared instances", () => {
  it("gives a shared instance ACCESS=licensed, VETRA_APP_ID, VETRA_GATE_URL and its token, delivered", async () => {
    await plan(h, appId);
    await ready();
    const row = await shared();
    const env = await envOf(row);
    const get = (n: string) => env.find((e) => e.name === n);
    expect(get("ACCESS")).toMatchObject({ value: "licensed", isSecret: false });
    expect(get("VETRA_APP_ID")).toMatchObject({
      value: appId,
      isSecret: false,
    });
    expect(get("VETRA_GATE_URL")).toMatchObject({
      value: GATE_ON.url,
      isSecret: false,
    });
    expect(get("VETRA_GATE_TOKEN")).toMatchObject({
      value: null,
      isSecret: true,
    });
    expect(get("RELAY")).toMatchObject({ value: "https://relay" });
    const gate = (await getGateToken(h.db, row.id))!;
    const delivered = h.secrets.store
      .get(tenantOf(row))!
      .get("VETRA_GATE_TOKEN")!;
    expect(hashGateToken(delivered)).toBe(gate.token_hash);
    expect(gate.delivered_at).not.toBeNull();
    expect(row.settings_delivered).toBe(row.target_settings);
    // The token is in no document and no row in plaintext.
    expect(JSON.stringify(await stateOf(row))).not.toContain(delivered);
    expect(JSON.stringify(await listInstances(h.db, appId))).not.toContain(
      delivered,
    );
    expect(JSON.stringify(await tokenRows())).not.toContain(delivered);
  });

  it("delivers a rotation as a settings change; the old token's grace starts at delivery", async () => {
    await plan(h, appId);
    await ready();
    const before = await shared();
    const old = (await getGateToken(h.db, before.id))!;
    await rotateInstanceGateToken(h.deps, owner, before.id);
    expect((await getGateToken(h.db, before.id))!.delivered_at).toBeNull();
    await reconcileInstancesOnce(h.deps);
    const after = await shared();
    expect(after.target_settings).not.toBe(before.target_settings);
    const gate = (await getGateToken(h.db, after.id))!;
    expect(
      hashGateToken(
        h.secrets.store.get(tenantOf(after))!.get("VETRA_GATE_TOKEN")!,
      ),
    ).toBe(gate.token_hash);
    expect(gate.previous_hash).toBe(old.token_hash);
    expect(gate.delivered_at).not.toBeNull();
    expect(Date.parse(gate.previous_until!)).toBe(
      Date.parse(gate.delivered_at!) + GATE_PREVIOUS_GRACE_MS,
    );
  });

  it("changes nothing with the gate off: no env, no token rows, the same settings revision", async () => {
    await h.close();
    ({ h, appId } = await gateHarness({}));
    await setAppSetting(h.deps, owner, {
      appId,
      name: "RELAY",
      value: "https://relay",
      secret: false,
    });
    await plan(h, appId);
    await ready();
    const row = await shared();
    expect((await envOf(row)).map((e) => e.name)).not.toContain("ACCESS");
    expect(await tokenRows()).toEqual([]);
    expect(row.target_settings).toBe(
      settingsForKind(await listAppSettings(h.db, appId), "shared").revision,
    );
  });

  it("leaves own and branch instances alone", async () => {
    await plan(h, appId, {
      id: "plan-own",
      slug: "pro",
      kind: "pro",
      access: "own",
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: "0x1111111111111111111111111111111111111111",
      licenseId: "l1",
    });
    await ready();
    const rows = await listInstances(h.db, appId);
    expect(rows.map((r) => r.kind).sort()).toEqual(["branch", "own"]);
    for (const r of rows) {
      const names = (await envOf(r)).map((e) => e.name);
      for (const n of [
        "ACCESS",
        "VETRA_APP_ID",
        "VETRA_GATE_URL",
        "VETRA_GATE_TOKEN",
      ])
        expect(names).not.toContain(n);
      expect(r.target_settings).toBe(
        settingsForKind(await listAppSettings(h.db, appId), r.kind).revision,
      );
    }
    expect(await tokenRows()).toEqual([]);
  });

  it("takes the gate away when switched off later", async () => {
    await plan(h, appId);
    await ready();
    const row = await shared();
    expect(h.secrets.store.get(tenantOf(row))!.has("VETRA_GATE_TOKEN")).toBe(
      true,
    );
    h.deps.cfg = testConfig({ plans: PLANS_ON });
    await reconcileInstancesOnce(h.deps);
    const after = await shared();
    const names = (await envOf(after)).map((e) => e.name);
    expect(names).not.toContain("ACCESS");
    expect(names).not.toContain("VETRA_GATE_TOKEN");
    expect(h.secrets.store.get(tenantOf(after))!.has("VETRA_GATE_TOKEN")).toBe(
      false,
    );
    expect(h.secrets.store.get(tenantOf(after))!.get("API_TOKEN")).toBe(
      "s3cret",
    );
  });

  it("issues a fresh token when the environment is recreated (its tenant was purged)", async () => {
    await plan(h, appId);
    await ready();
    const row = await shared();
    const old = (await getGateToken(h.db, row.id))!;
    await h.envs.delete(row.environment_id!);
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.purged).toContain(tenantOf(row));
    expect(await getGateToken(h.db, row.id)).toBeNull();
    await ready();
    const fresh = (await getGateToken(h.db, row.id))!;
    expect(fresh.token_id).not.toBe(old.token_id);
    expect(fresh.previous_hash).toBeNull();
    const again = await shared();
    expect(
      hashGateToken(
        h.secrets.store.get(tenantOf(again))!.get("VETRA_GATE_TOKEN")!,
      ),
    ).toBe(fresh.token_hash);
    const issued = await h.db
      .selectFrom("app_audit")
      .selectAll()
      .where("action", "=", "gate.token_issued")
      .execute();
    expect(issued).toHaveLength(2);
  });

  it("marks a delivery a crash left unmarked on the next pass", async () => {
    await plan(h, appId);
    await ready();
    const row = await shared();
    await h.db
      .updateTable("instance_gate_tokens")
      .set({ delivered_at: null })
      .execute();
    await reconcileInstancesOnce(h.deps);
    expect((await getGateToken(h.db, row.id))!.delivered_at).not.toBeNull();
  });
});

describe("Vetra-set settings of shared instances", () => {
  it("are listed only while the gate is on, and are the names the gate sets", async () => {
    const shown = (await appSettingsFor(h.deps, owner, appId)).vetraShared;
    expect(shown.map((s) => s.name)).toEqual([
      GATE_ACCESS_ENV,
      GATE_APP_ID_ENV,
      GATE_URL_ENV,
      GATE_TOKEN_ENV,
    ]);
    expect(shown.find((s) => s.name === GATE_TOKEN_ENV)!.secret).toBe(true);
    for (const s of shown) expect(s.value).toMatch(/shared instances only/);
    h.deps.cfg = testConfig({ plans: PLANS_ON });
    expect((await appSettingsFor(h.deps, owner, appId)).vetraShared).toEqual(
      [],
    );
  });
});

describe("instance gate status and rotation (GraphQL)", () => {
  const ctx = (address: string) => ({
    user: { address, chainId: 1, networkId: "eip155", appKey: "did:key:z" },
    headers: {},
  });
  const run = async (
    source: string,
    variables: Record<string, unknown>,
    who = OWNER,
  ) => {
    const resolvers = createResolvers(h.deps);
    const built = buildASTSchema(schema);
    const rootValue = { ...resolvers.Query, ...resolvers.Mutation };
    return graphql({
      schema: built,
      source,
      variableValues: variables,
      contextValue: ctx(who),
      rootValue: Object.fromEntries(
        Object.entries(rootValue).map(([k, f]) => [
          k,
          (args: unknown, c: unknown) =>
            (f as (...a: unknown[]) => unknown)(null, args, c),
        ]),
      ),
    });
  };
  const INSTANCES = `query($appId: ID!) { appInstances(appId: $appId) {
    id kind gate { enabled active reason tokenRotatedAt tokenDelivered } } }`;

  it("shows a shared instance's gate; own and branch instances have none", async () => {
    await seedRelease(h, appId, {
      version: "1.5.0",
      run: 101,
      kind: "release",
      digest: digest("c"),
      powerhouse: "6.2.3-dev.102",
    });
    await plan(h, appId, { target_version: "1.5.0" });
    await plan(h, appId, {
      id: "plan-own",
      slug: "pro",
      kind: "pro",
      access: "own",
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: "0x1111111111111111111111111111111111111111",
      licenseId: "l1",
    });
    await ready();
    const res = await run(INSTANCES, { appId });
    expect(res.errors).toBeUndefined();
    const list = (
      res.data as { appInstances: Array<{ kind: string; gate: unknown }> }
    ).appInstances;
    const shared = list.find((i) => i.kind === "shared")!;
    expect(shared.gate).toMatchObject({
      enabled: true,
      active: true,
      reason: null,
      tokenDelivered: true,
    });
    expect(
      (shared.gate as { tokenRotatedAt: string }).tokenRotatedAt,
    ).toBeTruthy();
    for (const i of list.filter((i) => i.kind !== "shared"))
      expect(i.gate).toBeNull();
    // Nothing secret in the answer.
    const row = (await getGateToken(h.db, (await byKind("shared")).id))!;
    const text = JSON.stringify(res);
    expect(text).not.toContain(row.token_hash);
    expect(text).not.toContain(row.token_ciphertext);
    expect(text).not.toContain(row.token_id);
  });

  it("says why the gate is not active on a release built below the floor", async () => {
    // 1.4.0 was built on 6.2.3 (fixture default) — above; seed one below.
    await seedRelease(h, appId, {
      version: "1.3.0",
      run: 99,
      kind: "release",
      powerhouse: "6.2.3-dev.101",
    });
    await plan(h, appId, { target_version: "1.3.0" });
    await reconcileInstancesOnce(h.deps);
    const [i] = (await appInstancesFor(h.deps, owner, appId)).filter(
      (x) => x.kind === "shared",
    );
    expect(i.gate).toMatchObject({ enabled: true, active: false });
    expect(i.gate!.reason).toMatch(/6\.2\.3-dev\.101.*6\.2\.3-dev\.102/);
  });

  it("shows the gate off as not active", async () => {
    await plan(h, appId);
    await reconcileInstancesOnce(h.deps);
    h.deps.cfg = testConfig({ plans: PLANS_ON });
    const [i] = (await appInstancesFor(h.deps, owner, appId)).filter(
      (x) => x.kind === "shared",
    );
    expect(i.gate).toMatchObject({ enabled: false, active: false });
    expect(i.gate!.reason).toMatch(/VETRA_APPS_GATE/);
  });

  it("rotates for the owner (undelivered until the next pass), never for strangers", async () => {
    await plan(h, appId);
    await ready();
    const id = (await byKind("shared")).id;
    const ROTATE = `mutation($id: ID!) { rotateInstanceGateToken(instanceId: $id) {
      id gate { tokenDelivered } } }`;
    const refused = await run(ROTATE, { id }, stranger.address);
    expect(refused.errors?.[0].extensions?.code).toBe("FORBIDDEN");
    const res = await run(ROTATE, { id });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      rotateInstanceGateToken: { id, gate: { tokenDelivered: false } },
    });
    await reconcileInstancesOnce(h.deps);
    const again = await run(INSTANCES, { appId });
    const shared = (
      again.data as {
        appInstances: Array<{ id: string; gate: { tokenDelivered: boolean } }>;
      }
    ).appInstances.find((i) => i.id === id)!;
    expect(shared.gate.tokenDelivered).toBe(true);
  });

  it("lists the Vetra-set shared settings through appSettings only with the gate on", async () => {
    const Q = `query($appId: ID!) { appSettings(appId: $appId) { vetraShared { name secret } } }`;
    const on = await run(Q, { appId });
    expect(on.errors).toBeUndefined();
    expect(
      (
        on.data as { appSettings: { vetraShared: Array<{ name: string }> } }
      ).appSettings.vetraShared.map((s) => s.name),
    ).toEqual(["ACCESS", "VETRA_APP_ID", "VETRA_GATE_URL", "VETRA_GATE_TOKEN"]);
    h.deps.cfg = testConfig({ plans: PLANS_ON });
    const off = await run(Q, { appId });
    expect(
      (off.data as { appSettings: { vetraShared: unknown[] } }).appSettings
        .vetraShared,
    ).toEqual([]);
  });
});
