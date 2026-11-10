import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  buildASTSchema,
  type GraphQLError,
  type GraphQLObjectType,
} from "graphql";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import { createRolloutStore } from "../rollout-db.js";
import {
  createReleaseResolvers,
  type ReleaseResolverDeps,
} from "../releases-resolvers.js";
import { schema } from "../schema.js";

const NOW = "2026-11-10T12:00:00.000Z";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
/** The same wallet, checksum-style: hex digits upper-cased. */
const shouting = (address: string) => `0x${address.slice(2).toUpperCase()}`;
const as = (address: string) => ({ user: { address }, isAdmin: () => false });
type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
type Resolvers = {
  VetraReleasesQueries: Record<string, Field>;
  VetraReleasesMutations: Record<string, Field>;
  PublisherEnvironment: Record<string, (p: unknown) => Promise<unknown>>;
};

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as GraphQLError).extensions?.code ?? `UNMAPPED: ${String(e)}`;
  }
}

const APP: AppDocView = {
  id: "a",
  name: "Sektar",
  slug: "sektar",
  owner: OWNER,
  status: "ACTIVE",
  identityDid: null,
  productionEnvironmentId: null,
  templates: [],
  terms: [],
  artifacts: [],
  tampered: false,
  tamperReason: null,
  licensingStateHash: "x",
  unverified: false,
};
const envRow = (
  environment_id: string,
  address: string,
): LicenseEnvironments => ({
  environment_id,
  root_license_id: `l-${environment_id}`,
  app_id: "a",
  user_did: `did:pkh:eip155:1:${address}`,
  license_id: `l-${environment_id}`,
  template_id: "t",
  label: null,
  template_hash: "h",
  channel_override: null,
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: NOW,
  updated_at: NOW,
});

let db: Kysely<VetraLicensingDB>;
let deps: ReleaseResolverDeps;
let r: Resolvers;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  deps = {
    auth: {
      findAppById: async (id) =>
        id === "a"
          ? { id, name: "Sektar", status: "ACTIVE", owner_address: OWNER }
          : null,
      listAppsForOwner: async () => [],
    },
    cfg: { enabled: true },
    store: createRolloutStore(db),
    envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
    apps: { app: async (id) => (id === "a" ? APP : null) },
    appWriter: { appendLicensingOps: async () => {} },
    envState: async () => null,
    newId: () => "r1",
    now: () => NOW,
  };
  r = createReleaseResolvers(deps) as unknown as Resolvers;
  await db
    .insertInto("license_environments")
    .values([envRow("cust", HOLDER), envRow("mine", OWNER)])
    .execute();
  await deps.store.insertUpdate({
    id: "u1",
    rollout_id: null,
    environment_id: "cust",
    app_id: "a",
    from_version: "1.0.0",
    to_version: "1.1.0",
    status: "PENDING",
    due_at: NOW,
    requested_at: null,
    started_at: null,
    finished_at: null,
    pre_update_dump_id: null,
    error: null,
    forced_at: null,
    created_at: NOW,
  });
});
afterEach(async () => {
  await db.destroy();
});

const q = (field: string, args: object, who = OWNER) =>
  r.VetraReleasesQueries[field]!({}, args, as(who));
const m = (field: string, args: object, who = OWNER) =>
  r.VetraReleasesMutations[field]!({}, args, as(who));

describe("the vetraReleases schema", () => {
  it("builds with the subgraph's schema and extends PublisherEnvironment", () => {
    const built = buildASTSchema(schema);
    expect(
      Object.keys((built.getType("Query") as GraphQLObjectType).getFields()),
    ).toContain("vetraReleases");
    expect(
      Object.keys(
        (
          built.getType("PublisherEnvironment") as GraphQLObjectType
        ).getFields(),
      ),
    ).toEqual(
      expect.arrayContaining([
        "rootLicenseId",
        "runningVersion",
        "isCanary",
        "update",
      ]),
    );
    expect(
      Object.keys(
        (
          built.getType("VetraReleasesMutations") as GraphQLObjectType
        ).getFields(),
      ),
    ).toStrictEqual([
      "setReleasePolicy",
      "setCanaryEnvironment",
      "promoteRelease",
      "resumeRollout",
      "forceEnvironmentUpdate",
      "updateEnvironmentNow",
    ]);
  });

  it("exposes only the spec's fields of an environment update", () => {
    const built = buildASTSchema(schema);
    const fields = (t: string) =>
      Object.keys((built.getType(t) as GraphQLObjectType).getFields());
    expect(fields("EnvironmentUpdateRecord")).toStrictEqual([
      "id",
      "fromVersion",
      "toVersion",
      "status",
      "dueAt",
      "requestedAt",
      "startedAt",
      "finishedAt",
      "error",
      "createdAt",
    ]);
    expect(fields("PublisherEnvironmentUpdate")).toStrictEqual([
      "status",
      "toVersion",
      "dueAt",
      "error",
    ]);
  });
});

describe("vetraReleases app fields: the app's owner only", () => {
  it("answers the owner and refuses anyone else as NOT_FOUND", async () => {
    expect(await q("releaseSettings", { appId: "a" })).toStrictEqual({
      appId: "a",
      policy: "AUTO",
      defaultNoticeHours: 72,
    });
    expect(await codeOf(q("releaseSettings", { appId: "a" }, STRANGER))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(q("rollouts", { appId: "nope" }))).toBe("NOT_FOUND");
    expect(
      await codeOf(
        m("setReleasePolicy", { appId: "a", policy: "AUTO" }, STRANGER),
      ),
    ).toBe("NOT_FOUND");
    expect(await q("rollouts", { appId: "a" })).toStrictEqual([]);
  });

  it("refuses a caller without a wallet as UNAUTHENTICATED", async () => {
    expect(
      await codeOf(
        r.VetraReleasesQueries.releaseSettings!({}, { appId: "a" }, {}),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("maps refusals to the contract's codes", async () => {
    expect(
      await codeOf(m("setReleasePolicy", { appId: "a", policy: "GATED" })),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(m("setReleasePolicy", { appId: "a", policy: "BOGUS" })),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        m("promoteRelease", {
          appId: "a",
          artifactName: "f",
          version: "1.1.0",
          noticeHours: -1,
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        m("setCanaryEnvironment", {
          appId: "a",
          environmentId: "cust",
          canary: true,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        m("setCanaryEnvironment", {
          appId: "a",
          environmentId: "nope",
          canary: true,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(m("resumeRollout", { appId: "a", rolloutId: "nope" })),
    ).toBe("NOT_FOUND");
    expect(
      await m("setCanaryEnvironment", {
        appId: "a",
        environmentId: "mine",
        canary: true,
      }),
    ).toBe(true);
  });

  it("maps an app the service cannot read to NOT_FOUND", async () => {
    // The owner check passes (the app record exists), but the ledger-checked
    // read of its document finds none: the service raises UnknownAppError.
    r = createReleaseResolvers({
      ...deps,
      apps: { app: async () => null },
    }) as unknown as Resolvers;
    expect(
      await codeOf(
        m("setCanaryEnvironment", {
          appId: "a",
          environmentId: "mine",
          canary: true,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("takes the caller's own environment as a canary whatever the case of their address", async () => {
    expect(
      await m(
        "setCanaryEnvironment",
        { appId: "a", environmentId: "mine", canary: true },
        shouting(OWNER),
      ),
    ).toBe(true);
    expect((await deps.envRows.byEnvironment("mine"))!.channel_override).toBe(
      "STAGING",
    );
  });

  it("refuses writes while licensing is switched off, after authorising", async () => {
    r = createReleaseResolvers({
      ...deps,
      cfg: { enabled: false },
    }) as unknown as Resolvers;
    expect(
      await codeOf(m("setReleasePolicy", { appId: "a", policy: "AUTO" })),
    ).toBe("LICENSING_DISABLED");
    expect(
      await codeOf(
        m("setReleasePolicy", { appId: "a", policy: "AUTO" }, STRANGER),
      ),
    ).toBe("NOT_FOUND");
    expect(await codeOf(q("releaseSettings", { appId: "a" }))).toBe("OK");
  });
});

describe("vetraReleases environment fields: the holder, or the app's owner", () => {
  it("shows the holder their update and lets them apply it now", async () => {
    expect(
      await q("environmentUpdate", { environmentId: "cust" }, HOLDER),
    ).toMatchObject({
      open: { toVersion: "1.1.0", status: "PENDING", canUpdateNow: true },
      history: [
        {
          id: "u1",
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
          status: "PENDING",
        },
      ],
    });
    expect(
      await m("updateEnvironmentNow", { environmentId: "cust" }, HOLDER),
    ).toBe(true);
    expect((await deps.store.update("u1"))!.requested_at).toBe(NOW);
  });

  it("returns only the schema's fields of each past update", async () => {
    const view = (await q(
      "environmentUpdate",
      { environmentId: "cust" },
      HOLDER,
    )) as {
      history: unknown[];
    };
    expect(view.history).toStrictEqual([
      {
        id: "u1",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        status: "PENDING",
        dueAt: NOW,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        createdAt: NOW,
      },
    ]);
  });

  it("knows the holder whatever the case of their address", async () => {
    const holder = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await db
      .insertInto("license_environments")
      .values(envRow("theirs", holder))
      .execute();
    expect(
      await codeOf(
        q("environmentUpdate", { environmentId: "theirs" }, shouting(holder)),
      ),
    ).toBe("OK");
  });

  it("lets the app's owner apply it too, and nobody else", async () => {
    expect(
      await codeOf(
        m("updateEnvironmentNow", { environmentId: "cust" }, STRANGER),
      ),
    ).toBe("NOT_FOUND");
    expect((await deps.store.update("u1"))!.requested_at).toBeNull();
    expect(await m("updateEnvironmentNow", { environmentId: "cust" })).toBe(
      true,
    );
    expect(
      await codeOf(q("environmentUpdate", { environmentId: "cust" })),
    ).toBe("OK");
    expect(
      await codeOf(q("environmentUpdate", { environmentId: "cust" }, STRANGER)),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        m("updateEnvironmentNow", { environmentId: "nope" }, HOLDER),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        m("updateEnvironmentNow", { environmentId: "mine" }, HOLDER),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(q("environmentUpdate", { environmentId: "mine" }, HOLDER)),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        r.VetraReleasesQueries.environmentUpdate!(
          {},
          { environmentId: "cust" },
          {},
        ),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("masks a failed read of PublisherEnvironment's release fields as INTERNAL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      r = createReleaseResolvers({
        ...deps,
        envState: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.7:5432");
        },
      }) as unknown as Resolvers;
      expect(
        await codeOf(r.PublisherEnvironment.update!({ environmentId: "cust" })),
      ).toBe("INTERNAL");
      expect(error.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
        "ECONNREFUSED",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("resolves PublisherEnvironment's release fields from one read per environment", async () => {
    const parent = { environmentId: "cust" };
    expect(await r.PublisherEnvironment.isCanary!(parent)).toBe(false);
    expect(await r.PublisherEnvironment.runningVersion!(parent)).toBeNull();
    expect(await r.PublisherEnvironment.update!(parent)).toStrictEqual({
      status: "PENDING",
      toVersion: "1.1.0",
      dueAt: NOW,
      error: null,
    });
  });
});
