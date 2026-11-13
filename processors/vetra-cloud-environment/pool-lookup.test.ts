import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up as upApps } from "../../subgraphs/vetra-apps/db/migrations.js";
import { up as upLicensing } from "../../subgraphs/vetra-licensing/db/migrations.js";
import { ensureInstancesTable } from "../../subgraphs/vetra-apps/db/migrations.js";
import { createWarmPoolStore } from "../../subgraphs/vetra-licensing/warm-pool-db.js";
import { createInstancePoolLookup } from "../../subgraphs/vetra-apps/plans/pool-lookup.js";
import { generateValuesYaml } from "./gitops.js";
import { createWarmLookup } from "./warm-lookup.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

let db: Kysely<any>;
beforeEach(() => {
  db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  vi.stubEnv("FUSION_IMAGE_PROJECTS", "acme");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": {} }) })),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.destroy();
});

/** A database whose every read fails with a connection error (not a missing table). */
const brokenDb = () =>
  ({
    selectFrom: () => {
      throw Object.assign(new Error("connection reset"), { code: "08006" });
    },
  }) as unknown as Kysely<any>;

const row = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  app_id: "app-1",
  kind: "own",
  name: "own-warm-x",
  status: "ready",
  environment_id: "env-warm",
  warm: true,
  created_at: "2026-11-12T00:00:00.000Z",
  updated_at: "2026-11-12T00:00:00.000Z",
  ...over,
});

describe("createInstancePoolLookup", () => {
  beforeEach(() => upApps(db));

  it("answers for an unclaimed warm instance, not for a claimed one or an unknown document", async () => {
    await db.insertInto("instances").values(row()).execute();
    const lookup = createInstancePoolLookup(db);
    expect(await lookup("env-warm")).toEqual({ appId: "app-1" });
    expect(await lookup("env-other")).toBeNull();
    await db
      .updateTable("instances")
      .set({ warm: false, holder_address: "0x1" })
      .execute();
    expect(await lookup("env-warm")).toBeNull();
  });

  it("still answers while a warm row is on its way out (removed, not yet deleted)", async () => {
    await db
      .insertInto("instances")
      .values(row({ removed_at: "2026-11-12T01:00:00.000Z" }))
      .execute();
    expect(await createInstancePoolLookup(db)("env-warm")).toEqual({
      appId: "app-1",
    });
  });
});

describe("createInstancePoolLookup on a database that is not migrated yet", () => {
  it("answers null for a missing instances table", async () => {
    expect(await createInstancePoolLookup(db)("env-warm")).toBeNull();
  });

  it("answers null for an instances table without the warm column", async () => {
    await ensureInstancesTable(db);
    expect(await createInstancePoolLookup(db)("env-warm")).toBeNull();
  });

  it("throws on any other failure, so a warm environment never renders open", async () => {
    await expect(
      createInstancePoolLookup(brokenDb())("env-warm"),
    ).rejects.toThrow("connection reset");
  });
});

describe("createWarmLookup (licensing's pool first, then own plans' pools)", () => {
  beforeEach(async () => {
    await upApps(db);
    await upLicensing(db);
  });

  it("licensing's warm pool is unchanged: a live unclaimed row answers, a claimed one does not", async () => {
    const store = createWarmPoolStore(db);
    await store.insertWarming({
      environmentId: "env-sektar",
      appId: "app-sektar",
      templateId: "t",
      templateHash: "h",
      poolSize: 1,
      nowIso: "2026-11-12T00:00:00.000Z",
    });
    const lookup = createWarmLookup(db, db);
    expect(await lookup("env-sektar")).toEqual({ appId: "app-sektar" });
    await db.updateTable("app_warm_pool").set({ state: "CLAIMED" }).execute();
    expect(await lookup("env-sektar")).toBeNull();
  });

  it("licensing is asked first; the instances pool only when it says no", async () => {
    await db.insertInto("instances").values(row()).execute();
    const lookup = createWarmLookup(db, db);
    expect(await lookup("env-warm")).toEqual({ appId: "app-1" });
    expect(await lookup("licensed-env")).toBeNull();
  });

  it("a licensing failure other than a missing table still fails the lookup", async () => {
    await expect(createWarmLookup(brokenDb(), db)("env-warm")).rejects.toThrow(
      "connection reset",
    );
  });

  it("a missing licensing table falls through to the instances pool", async () => {
    const empty = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await db.insertInto("instances").values(row()).execute();
      expect(await createWarmLookup(empty, db)("env-warm")).toEqual({
        appId: "app-1",
      });
    } finally {
      await empty.destroy();
    }
  });
});

describe("generateValuesYaml with the composed lookup", () => {
  const dbStub = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => undefined }),
      }),
    }),
    insertInto: () => ({ values: () => ({ execute: async () => undefined }) }),
  } as unknown as Kysely<DB>;
  const state = {
    owner: null,
    ownerOrgId: null,
    orgOperators: [],
    label: "Shop · own (warm)",
    genericSubdomain: "calm-bat-b4qzzqbb",
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.vetra.io",
    services: [
      {
        type: "FUSION",
        prefix: "fusion",
        enabled: true,
        url: null,
        status: "ACTIVE",
        version: "sha-abc1234def56",
        config: null,
        selectedRessource: null,
      },
    ],
    fusion: {
      image: "cr.vetra.io/acme/shop",
      env: [{ name: "PH_HOST", value: "cli", isSecret: false }],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    },
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    backupSchedule: null,
    managedBy: null,
    app: null,
  } as unknown as VetraCloudEnvironmentState;

  it("renders the ingress closed for a warm instance document and open once claimed", async () => {
    await upApps(db);
    await upLicensing(db);
    await db.insertInto("instances").values(row()).execute();
    const lookup = createWarmLookup(db, db);
    const allow = async () => "acme";
    const closed = await generateValuesYaml(
      dbStub,
      state,
      "env-warm",
      null,
      allow,
      lookup,
    );
    expect(closed).toContain("closed: true");
    await db
      .updateTable("instances")
      .set({ warm: false, holder_address: "0x1" })
      .execute();
    const open = await generateValuesYaml(
      dbStub,
      state,
      "env-warm",
      null,
      allow,
      lookup,
    );
    expect(open).not.toContain("closed:");
  });
});

describe("createInstancePoolLookup: rehearsal clones", () => {
  beforeEach(() => upApps(db));
  const sw = (id: string, mode: string) =>
    db
      .insertInto("switchovers")
      .values({
        id,
        mode,
        app_id: "app-1",
        environment_id: "env-old",
        old_tenant: "t",
        old_host: "h",
        licence_root_id: "r",
        holder_address: "0x9",
        kind: "own",
        plan_id: "p",
        release_version: "1",
        release_digest: "d",
        state: "PLANNED",
        created_by: "x",
        created_at: "2026-11-12",
        updated_at: "2026-11-12",
      } as never)
      .execute();

  it("marks a holderless row of a dry-run switch-over, not of a real one", async () => {
    await sw("s-dry", "dry_run");
    await sw("s-real", "real");
    await db
      .insertInto("instances")
      .values(
        row({ id: "c1", warm: false, environment_id: "env-clone", switchover_id: "s-dry" }),
      )
      .execute();
    await db
      .insertInto("instances")
      .values(
        row({ id: "c2", name: "own-2", warm: false, environment_id: "env-new", switchover_id: "s-real" }),
      )
      .execute();
    const lookup = createInstancePoolLookup(db);
    expect(await lookup("env-clone")).toEqual({ appId: "app-1", rehearsal: true });
    expect(await lookup("env-new")).toBeNull();
  });

  it("marks a real switch-over's new instance unverified only in STARTING and VERIFYING", async () => {
    await sw("s-real", "real");
    await db
      .insertInto("instances")
      .values(
        row({ id: "n1", warm: false, environment_id: "env-new", switchover_id: "s-real", holder_address: "0x9" }),
      )
      .execute();
    const lookup = createInstancePoolLookup(db);
    const at = async (state: string) => {
      await db.updateTable("switchovers").set({ state }).execute();
      return lookup("env-new");
    };
    for (const state of ["PREPARED", "HOLDING_OLD", "RESTORING", "CHECKING_COPY", "LINKING", "AWAITING_CONFIRMATION"])
      expect(await at(state)).toBeNull();
    for (const state of ["STARTING", "VERIFYING"])
      expect(await at(state)).toEqual({ appId: "app-1", unverified: true });
    // Linked (switchover_id cleared): open.
    await db.updateTable("instances").set({ switchover_id: null }).execute();
    expect(await lookup("env-new")).toBeNull();
  });

  it("does not mark a clone row that has a holder", async () => {
    await sw("s-dry", "dry_run");
    await db
      .insertInto("instances")
      .values(
        row({ id: "c1", warm: false, environment_id: "env-clone", switchover_id: "s-dry", holder_address: "0x1" }),
      )
      .execute();
    expect(await createInstancePoolLookup(db)("env-clone")).toBeNull();
  });

  it("throws on other errors", async () => {
    await expect(createInstancePoolLookup(brokenDb())("x")).rejects.toThrow("connection reset");
  });
});
