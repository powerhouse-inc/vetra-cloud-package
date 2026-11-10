import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildASTSchema,
  graphql,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
} from "graphql";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import {
  approveChanges,
  markChangesPushed,
  markDeploymentStarted,
  reportDeploymentFailed,
  reportDeploymentSucceeded,
  setLabel,
  setServiceVersion,
  sleepEnvironment,
  wakeEnvironment,
} from "document-models/vetra-cloud-environment";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { createReactorEnvGateway } from "../../vetra-apps/envs.js";
import { loadAppsConfig } from "../../vetra-apps/config.js";
import { up as upApps } from "../../vetra-apps/db/migrations.js";
import type { VetraAppsDB } from "../../vetra-apps/db/schema.js";
import {
  ciRecordArtifact,
  type AppsDeps,
  type CiIdentity,
} from "../../vetra-apps/service.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { schema } from "../schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { issueLicense } from "../issue.js";
import {
  createAppLedger,
  createAppLicensingWriter,
  reactorLedgerSource,
} from "../licensing-ledger.js";
import { loadLicensingConfig } from "../config.js";
import {
  createChainEnvironmentRows,
  provisionChain,
  type ChainEnvDeps,
} from "../environments.js";
import { AppLicenseHandler } from "../handler.js";
import { createLifecycleStore } from "../lifecycle.js";
import {
  markEnded,
  markResumed,
  type OffboardingDeps,
} from "../offboarding.js";
import { createWarmPoolStore } from "../warm-pool-db.js";
import { createRolloutStore, releasePolicyOf } from "../rollout-db.js";
import { activeUpdateGate, createUpdateGate } from "../update-gate.js";
import { trackReleases, type ReleaseTrackerDeps } from "../release-tracker.js";
import { createManagedBySync } from "../managed-by.js";
import { runAll } from "../run-all.js";
import { mergeResolvers } from "../merge-resolvers.js";
import { createPublisherResolvers } from "../publisher-resolvers.js";
import { createReleaseResolvers } from "../releases-resolvers.js";
import {
  promoteRelease,
  requestUpdateNow,
  resumeRollout,
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
} from "../release-service.js";

/**
 * The release rollout end to end (spec 2026-11-10 §9): a real reactor, real
 * environment and app documents, CI's artifact recording (ciRecordArtifact
 * with the release policy, as vetra-apps/index.ts wires it), the handler
 * wired as vetra-licensing/index.ts wires it with the keeper applying (the
 * update gate; release tracking and the managed-by marker through runAll;
 * markEnded on a chain's end, markResumed on its resumption) and the release
 * operations. Only gitops and ArgoCD are played by the test (deploy / fail
 * below), and the housekeeping that puts an environment to sleep and wakes
 * it (the model's own SLEEP_ENVIRONMENT and WAKE_ENVIRONMENT).
 *
 * Not proven here, because it differs from vetra-licensing/index.ts:
 * provision, onEnded and onResumed run without the chain lock
 * (provisionChain, not provisionChainExclusive; no underChainOf); afterApp
 * (offboarding, reporting tokens) is a no-op; there is no warm pool; the
 * release mutations are called on the service directly, not through the
 * vetraReleases resolvers (only the publisher's read goes through the
 * resolver map); publisher auth has no Renown organisation lookups.
 */
const APP = "5d2c1b7a-5d4f-4e6a-8b9c-0d1e2f3a4b6d";
/** The App's CI workload identity (its apps row's identity_did). */
const APP_DID = "did:key:zDnaeWebIdentity";
const PUBLISHER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER_1 = "0x1111111111111111111111111111111111111111";
const CUSTOMER_2 = "0x2222222222222222222222222222222222222222";
const CUSTOMER_3 = "0x3333333333333333333333333333333333333333";
/** Joins while the canary is updating, leaves mid-rollout. */
const LEAVER = "0x4444444444444444444444444444444444444444";
const did = (address: string) => `did:pkh:eip155:1:${address}`;
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const ref = (v: string) => `cr.vetra.io/acme/web:${v}`;
const SIGNATURE: [string, string, string, string, string] = [
  "0",
  "k",
  "hash",
  "prev",
  "0xsig",
];
/**
 * An action as a holder's wallet signs it in vetra.to. The reactor client
 * keeps a signed action's signer (it signs only unsigned ones with its own,
 * system, signer); this test reactor verifies no signature.
 */
const signedBy = <A extends object>(address: string, action: A) => ({
  ...action,
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "vetra.to", key: "k" },
      signatures: [SIGNATURE],
    },
  },
});

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("app release rollout against a real reactor + real database", () => {
  let client: Client;
  let db: Kysely<VetraLicensingDB>;
  let handler: AppLicenseHandler;
  let envs: ReturnType<typeof createReactorEnvGateway>;
  let appDocs: ReturnType<typeof createReactorAppDocStore>;
  let licenseGateway: ReturnType<typeof createReactorLicenseGateway>;
  let issueDeps: Parameters<typeof issueLicense>[0];
  let service: ReleaseServiceDeps;
  let rollouts: ReturnType<typeof createRolloutStore>;
  /**
   * The publisher and release resolver maps merged as index.ts merges them
   * (without the machine and subscription maps), served by graphql-js.
   */
  let publisherQuery: (query: string, address: string) => Promise<unknown>;
  let clock = T0;
  const now = () => new Date(clock).toISOString();
  const envOf: Record<string, string> = {};
  /** What each piece logs at warn (and error) level. */
  const logged = {
    handler: [] as string[],
    gate: [] as string[],
    tracker: [] as string[],
    managedBy: [] as string[],
  };
  const into = (sink: string[]) => ({
    info: () => {},
    warn: (m: string) => {
      sink.push(m);
    },
    error: (m: string) => {
      sink.push(m);
    },
  });
  /** Set for some ticks: the tracker's reads of the environment documents fail. */
  let envReadsFail = false;
  /** Set for one tick: the tracker's reads of the APPLYING updates fail. */
  let rolloutStoreFails = false;
  /** CI, as the vetra-apps routes authenticate it: the App's identity, acting for its owner. */
  let appsDeps: AppsDeps;
  const ci: CiIdentity = {
    address: PUBLISHER,
    chainId: 1,
    appDid: APP_DID,
    claim: null,
  };

  const rows = () =>
    db.selectFrom("license_environments").selectAll().execute();
  const fusionVersion = async (id: string) =>
    (await envs.getState(id))!.services.find((s) => s.type === "FUSION")
      ?.version;
  /** What gitops and observability report once a rollout went well. */
  const deploy = (id: string) =>
    envs.execute(id, [
      markChangesPushed({}),
      markDeploymentStarted({}),
      reportDeploymentSucceeded({}),
    ]);
  const fail = (id: string) =>
    envs.execute(id, [
      markChangesPushed({}),
      markDeploymentStarted({}),
      reportDeploymentFailed({ code: "CRASH", message: "boot loop" }),
    ]);
  const latestUpdate = (environmentId: string) =>
    rollouts.latest(environmentId);
  const tick = () => handler.reconcileOnce();
  /** Ticks until `done` (the keeper backs a chain off after a failed step). */
  const tickUntil = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 40; i++) {
      await tick();
      if (await done()) return;
    }
    throw new Error("the keeper never got there");
  };
  /**
   * Ticks until every environment's update of the rollout SUCCEEDED,
   * deploying each once its version is set, and checks on every tick that
   * at most one of them is applying.
   */
  const applyOneAtATime = async (rolloutId: string, ids: string[]) => {
    const statusOf = async (id: string) =>
      (await rollouts.updateFor(rolloutId, id))?.status;
    await tickUntil(async () => {
      const applying: string[] = [];
      for (const id of ids)
        if ((await statusOf(id)) === "APPLYING") applying.push(id);
      expect(applying.length).toBeLessThanOrEqual(1);
      if (applying[0]) await deploy(applying[0]);
      for (const id of ids)
        if ((await statusOf(id)) !== "SUCCEEDED") return false;
      return true;
    });
  };
  const issue = (holder: string) =>
    issueLicense(issueDeps, {
      appId: APP,
      user: did(holder),
      kind: "pro",
      issuer: "PUBLISHER_GRANT",
      details: {},
      issuedBy: PUBLISHER,
      label: holder.slice(0, 6),
      now: now(),
    });
  /** A FUSION build CI records, pointing `channel` at it (none: only recorded). */
  const publish = (version: string, channel?: "LATEST") =>
    ciRecordArtifact(appsDeps, ci, {
      appId: APP,
      kind: "FUSION_IMAGE",
      name: "web",
      version,
      reference: ref(version),
      ...(channel ? { channel } : {}),
    });
  const channelOf = async (channel: string) =>
    (await service.apps.app(APP))!.artifacts
      .find((a) => a.name === "web")!
      .channels.find((c) => c.channel === channel)?.version ?? null;

  beforeAll(async () => {
    client = await new ReactorClientBuilder()
      .withReactorBuilder(
        new ReactorBuilder().withDocumentModelSources([...documentModels]),
      )
      .build();
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await up(db as Kysely<any>);

    const ledger = createAppLedger({
      db,
      source: reactorLedgerSource(client as never),
      now,
    });
    appDocs = createReactorAppDocStore(
      client as never,
      undefined,
      async () => ledger,
    );
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.addTemplate({ id: "host", name: null, mode: "DEDICATED" }),
      appActions.addTemplateService({
        templateId: "host",
        id: "f",
        type: "FUSION",
        prefix: "web",
        artifactName: "web",
        artifactChannel: "LATEST",
      }),
      appActions.addTerm({
        id: "k",
        kind: "pro",
        label: "Pro",
        templateId: "host",
        validityDays: null,
        issuers: ["PUBLISHER_GRANT"],
      }),
      appActions.publishTerm({ id: "k" }),
    ]);
    // The vetra-apps side: the App's row (ownership and CI identity) and
    // the release policy read from this database, as vetra-apps/index.ts.
    const appsDb = new Kysely<VetraAppsDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await upApps(appsDb as Kysely<any>);
    await appsDb
      .insertInto("apps")
      .values({
        id: APP,
        slug: "web",
        name: "Web",
        owner_address: PUBLISHER,
        owner_chain_id: 1,
        status: "ACTIVE",
        installation_id: "77",
        repository_id: "4242",
        repository_full_name: "acme/web",
        production_branch: "main",
        production_environment_id: "env-web",
        previews_enabled: false,
        preview_limit: 0,
        preview_ttl_days: 7,
        harbor_project: "acme",
        harbor_robot_name: "robot$acme",
        harbor_robot_id: null,
        harbor_robot_secret_enc: "unused",
        identity_did: APP_DID,
        identity_expires_at: null,
        owner_org_id: null,
        studio_environment_id: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    envs = createReactorEnvGateway(client as never);
    appsDeps = {
      db: appsDb,
      envs,
      cfg: loadAppsConfig({}),
      github: null,
      harbor: null,
      renown: null,
      generateSubdomain,
      now: () => new Date(clock),
      newId: () => randomUUID(),
      logger: into([]),
      docs: appDocs,
      releasePolicy: (id) => releasePolicyOf(db, id),
    };
    await publish("1.0.0", "LATEST");

    const appReads = createAppReads(client as never, {
      ledger: ledger.lookup,
      heal: ledger.heal,
    });
    expect(await appReads.app(APP)).toMatchObject({
      tampered: false,
      unverified: false,
    });
    const reads = createReactorLicenseReads(client as never);
    const lifecycle = createLifecycleStore(db, now);
    licenseGateway = createReactorLicenseGateway(client as never, {
      lifecycle,
    });
    const grants = createGrantStore(db);
    const cfg = {
      ...loadLicensingConfig({}),
      enabled: true,
      dryRun: false,
      scanIntervalMs: 1_000,
    };
    const chainRows = createChainEnvironmentRows(db, cfg);
    rollouts = createRolloutStore(db);
    const silent = { info: () => {}, warn: () => {}, error: () => {} };
    const updates = activeUpdateGate(
      cfg,
      createUpdateGate({ store: rollouts, logger: into(logged.gate) }),
    );
    expect(updates).toBeDefined();
    const chainEnvDeps: ChainEnvDeps = {
      rows: chainRows,
      envs,
      generateSubdomain,
      updates,
    };
    const offboarding: OffboardingDeps = {
      rows: chainRows,
      envStatus: async (id) => (await envs.getState(id))?.status ?? null,
      sleep: async (id) => {
        await envs.execute(id, [sleepEnvironment({})]);
      },
      wake: async (id) => {
        await envs.execute(id, [wakeEnvironment({})]);
      },
      destroy: (id) => envs.delete(id),
      cfg,
      logger: silent,
      now,
    };
    const markManaged = createManagedBySync({
      envs,
      logger: into(logged.managedBy),
    });
    const releaseTracking: ReleaseTrackerDeps = {
      store: {
        ...rollouts,
        applyingOf: (appId) =>
          rolloutStoreFails
            ? Promise.reject(new Error("rollout store down"))
            : rollouts.applyingOf(appId),
      },
      envState: (id) =>
        envReadsFail
          ? Promise.reject(new Error("environment document read failed"))
          : envs.getState(id),
      cfg,
      logger: into(logged.tracker),
      now,
    };
    handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      grants: () => grants.provenance(),
      lifecycle: () => lifecycle.all(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provisionChain(chainEnvDeps, input),
      setStage: (licenseId, stage) =>
        licenseGateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      onEnded: (_appId, env) => markEnded(offboarding, env),
      onResumed: (_appId, env) => markResumed(offboarding, env),
      afterChains: (app, after) =>
        runAll([
          () => trackReleases(releaseTracking, app, after),
          () => markManaged(app, after),
        ]),
      afterApp: async () => {},
      migrationComplete: async () => true,
      cfg,
      logger: into(logged.handler),
      now,
    });
    const appWriter = createAppLicensingWriter({
      docs: createReactorDocGateway(client as never, APP_DOC_TYPE, "app", () =>
        Promise.reject(new Error("never creates")),
      ),
      ledger,
    });
    // No kick: the test runs every tick itself.
    service = {
      store: rollouts,
      envRows: chainRows,
      apps: appReads,
      appWriter,
      envState: (id) => envs.getState(id),
      newId: () => randomUUID(),
      now,
    };

    const owners = {
      findAppById: async (id: string) =>
        id === APP
          ? { id, name: "Web", status: "ACTIVE", owner_address: PUBLISHER }
          : null,
      listAppsForOwner: async (address: string) =>
        address === PUBLISHER
          ? [
              {
                id: APP,
                name: "Web",
                status: "ACTIVE",
                owner_address: PUBLISHER,
              },
            ]
          : [],
    };
    issueDeps = {
      owners,
      apps: appReads,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: licenseGateway.create,
      executeLicence: licenseGateway.execute,
      grants,
      lifecycle,
      migrationComplete: async () => false,
      logger: silent,
    };
    for (const holder of [PUBLISHER, CUSTOMER_1, CUSTOMER_2, CUSTOMER_3])
      await issue(holder);

    const resolvers = mergeResolvers(
      createPublisherResolvers({
        auth: owners,
        appEnvironments: async () => [],
        apps: appReads,
        appWriter,
        licences: reads,
        lifecycle,
        licenseGateway,
        issue: { ...issueDeps, grants },
        grants,
        envRows: chainRows,
        warmPool: createWarmPoolStore(db),
        codes: db,
        keyVault: null,
        cfg,
        newId: () => randomUUID(),
        now,
      }) as Record<string, Record<string, unknown>>,
      createReleaseResolvers({ ...service, auth: owners, cfg }) as Record<
        string,
        Record<string, unknown>
      >,
    );
    const served = buildASTSchema(schema);
    for (const [typeName, fields] of Object.entries(resolvers)) {
      const type = served.getType(typeName) as GraphQLObjectType;
      for (const [field, resolve] of Object.entries(fields))
        type.getFields()[field]!.resolve = resolve as GraphQLFieldResolver<
          unknown,
          unknown
        >;
    }
    publisherQuery = async (source, address) => {
      const result = await graphql({
        schema: served,
        source,
        contextValue: {
          user: { address, networkId: "eip155", chainId: 1 },
          isAdmin: () => false,
        },
      });
      expect(result.errors).toBeUndefined();
      return result.data;
    };
  }, 120_000);

  it("builds every holder's environment on LATEST and marks it managed by the app", async () => {
    await tick();
    const all = await rows();
    expect(all).toHaveLength(4);
    for (const r of all) {
      envOf[r.user_did] = r.environment_id;
      await deploy(r.environment_id);
      expect(await fusionVersion(r.environment_id)).toBe("1.0.0");
      expect((await envs.getState(r.environment_id))!.managedBy).toMatchObject({
        appId: APP,
        templateId: "host",
        services: ["FUSION"],
      });
    }
  });

  it("gating needs a canary, and keeps the canary's image on STAGING", async () => {
    await expect(
      setReleasePolicy(service, { appId: APP, policy: "GATED" }),
    ).rejects.toThrow(/canary/);
    await setCanaryEnvironment(service, {
      appId: APP,
      environmentId: envOf[did(PUBLISHER)]!,
      canary: true,
      callerDid: did(PUBLISHER),
    });
    await setReleasePolicy(service, {
      appId: APP,
      policy: "GATED",
      defaultNoticeHours: 72,
    });
    const web = (await service.apps.app(APP))!.artifacts.find(
      (a) => a.name === "web",
    )!;
    expect(web.channels).toEqual(
      expect.arrayContaining([{ channel: "STAGING", version: "1.0.0" }]),
    );
    await tick();
    expect(await latestUpdate(envOf[did(PUBLISHER)]!)).toBeNull();
  });

  it("a release goes to the canary first, and no further", async () => {
    // CI aims the build at LATEST; the app is gated, so it lands on STAGING.
    await publish("1.1.0", "LATEST");
    expect(await channelOf("STAGING")).toBe("1.1.0");
    expect(await channelOf("LATEST")).toBe("1.0.0");
    await tick();
    const canary = envOf[did(PUBLISHER)]!;
    expect(await fusionVersion(canary)).toBe("1.1.0");
    expect(await latestUpdate(canary)).toMatchObject({
      status: "APPLYING",
      rollout_id: null,
      to_version: "1.1.0",
    });
    for (const c of [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3])
      expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
    // Not promotable while the canary is not READY on it.
    await expect(
      promoteRelease(service, {
        appId: APP,
        artifactName: "web",
        version: "1.1.0",
        promotedBy: PUBLISHER,
      }),
    ).rejects.toThrow("no canary environment of this app is READY on 1.1.0");
    expect(await channelOf("LATEST")).toBe("1.0.0");
    expect(await rollouts.rolloutsOf(APP)).toStrictEqual([]);
  });

  it("an environment document the tracker cannot read is logged once, and fails nothing", async () => {
    const canary = envOf[did(PUBLISHER)]!;
    await deploy(canary);
    envReadsFail = true;
    await tick();
    await tick();
    envReadsFail = false;
    // Not observed: still applying (within its timeout), and no release step failed.
    expect(await latestUpdate(canary)).toMatchObject({ status: "APPLYING" });
    expect(logged.tracker).toStrictEqual([
      `[licensing] reading environment ${canary} of app ${APP} failed; tracking it as not observed: Error: environment document read failed`,
    ]);
    expect(logged.handler).toStrictEqual([]);
  });

  it("a release step that fails does not stop the other, and is logged once", async () => {
    const canary = envOf[did(PUBLISHER)]!;
    // A holder joins on the tick the tracker's store fails.
    await issue(LEAVER);
    rolloutStoreFails = true;
    await tick();
    rolloutStoreFails = false;
    const joined = (await rows()).find((r) => r.user_did === did(LEAVER))!;
    envOf[did(LEAVER)] = joined.environment_id;
    // The tracker failed: the canary's update is not settled yet...
    expect(await latestUpdate(canary)).toMatchObject({ status: "APPLYING" });
    // ...and the managed-by sync after it still marked the new environment.
    expect(
      (await envs.getState(joined.environment_id))!.managedBy,
    ).toMatchObject({ appId: APP, templateId: "host", services: ["FUSION"] });
    expect(logged.handler).toStrictEqual([
      `[licensing] release work of app ${APP} failed: Error: rollout store down`,
    ]);
    await tick();
    expect(await latestUpdate(canary)).toMatchObject({ status: "SUCCEEDED" });
    expect(logged.handler).toHaveLength(1);
    await deploy(joined.environment_id);
    expect(await fusionVersion(joined.environment_id)).toBe("1.0.0");
  });

  it("only a version a canary is READY on can be promoted", async () => {
    // A newer build CI recorded without moving a channel: no canary runs it.
    await publish("1.2.0");
    await expect(
      promoteRelease(service, {
        appId: APP,
        artifactName: "web",
        version: "1.2.0",
        promotedBy: PUBLISHER,
      }),
    ).rejects.toThrow("no canary environment of this app is READY on 1.2.0");
    expect(await channelOf("LATEST")).toBe("1.0.0");
    expect(await rollouts.rolloutsOf(APP)).toStrictEqual([]);
  });

  it("a promotion gives customers notice and changes nothing yet", async () => {
    const rollout = await promoteRelease(service, {
      appId: APP,
      artifactName: "web",
      version: "1.1.0",
      noticeHours: 24,
      promotedBy: PUBLISHER,
    });
    expect(rollout).toMatchObject({
      status: "ACTIVE",
      apply_after: new Date(T0 + 24 * HOUR).toISOString(),
    });
    expect(await channelOf("LATEST")).toBe("1.1.0");
    await tick();
    for (const c of [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3, LEAVER]) {
      expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
      expect(await latestUpdate(envOf[did(c)]!)).toMatchObject({
        status: "PENDING",
        rollout_id: rollout.id,
        due_at: rollout.apply_after,
      });
    }
  });

  it("a customer who leaves mid-rollout has its waiting update closed", async () => {
    const leaving = (await rows()).find((r) => r.user_did === did(LEAVER))!;
    await licenseGateway.execute(leaving.license_id, [
      licenseActions.revokeLicense({ reason: "refund" }),
    ]);
    await tick();
    expect(
      (await rows()).find((r) => r.environment_id === leaving.environment_id)!
        .ended_at,
    ).not.toBeNull();
    const [closed] = await rollouts.history(leaving.environment_id, 1);
    expect(closed).toMatchObject({
      status: "SUPERSEDED",
      error: "environment ended",
    });
    expect((await rollouts.rolloutsOf(APP))[0]!.status).toBe("ACTIVE");
  });

  it("a managed environment's FUSION version is the template's: its holder cannot set it", async () => {
    const one = envOf[did(CUSTOMER_1)]!;
    await expect(
      envs.execute(one, [
        signedBy(
          CUSTOMER_1,
          setServiceVersion({ type: "FUSION", version: "1.1.0" }),
        ),
      ]),
    ).rejects.toThrow(/ManagedByTemplate/);
    expect(await fusionVersion(one)).toBe("1.0.0");
    // The keeper's own (unsigned) move of the same environment follows below.
  });

  it("'update now' applies one customer; its failure pauses the rollout for everyone", async () => {
    const one = envOf[did(CUSTOMER_1)]!;
    const two = envOf[did(CUSTOMER_2)]!;
    await requestUpdateNow(
      service,
      (await rows()).find((r) => r.environment_id === one)!,
    );
    await tick();
    expect(await fusionVersion(one)).toBe("1.1.0");
    expect(await latestUpdate(one)).toMatchObject({ status: "APPLYING" });
    expect(await latestUpdate(two)).toMatchObject({ status: "PENDING" });
    await fail(one);
    await tick();
    expect(await latestUpdate(one)).toMatchObject({
      status: "FAILED",
      error: "the deployment of 1.1.0 failed",
    });
    const [rollout] = await rollouts.rolloutsOf(APP);
    expect(rollout).toMatchObject({
      status: "PAUSED",
      paused_reason: expect.stringContaining(one),
    });
    // Past the deadline, still paused: nobody else moves.
    clock = T0 + 25 * HOUR;
    await tick();
    for (const c of [CUSTOMER_2, CUSTOMER_3]) {
      expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
      expect(await latestUpdate(envOf[did(c)]!)).toMatchObject({
        status: "PENDING",
      });
    }
  });

  it("the publisher reads each environment's version, canary flag and update", async () => {
    const data = (await publisherQuery(
      `{ vetraPublisher { environments(appId: "${APP}") { environmentId runningVersion isCanary update { status toVersion dueAt error } } } }`,
      PUBLISHER,
    )) as { vetraPublisher: { environments: { environmentId: string }[] } };
    // graphql-js builds results without a prototype: compared with toEqual.
    const byId = new Map(
      data.vetraPublisher.environments.map((e) => [e.environmentId, e]),
    );
    const dueAt = new Date(T0 + 24 * HOUR).toISOString();
    expect(byId.get(envOf[did(PUBLISHER)]!)).toEqual({
      environmentId: envOf[did(PUBLISHER)],
      runningVersion: "1.1.0",
      isCanary: true,
      update: {
        status: "SUCCEEDED",
        toVersion: "1.1.0",
        dueAt: new Date(T0).toISOString(),
        error: null,
      },
    });
    expect(byId.get(envOf[did(CUSTOMER_1)]!)).toEqual({
      environmentId: envOf[did(CUSTOMER_1)],
      runningVersion: "1.1.0",
      isCanary: false,
      update: {
        status: "FAILED",
        toVersion: "1.1.0",
        dueAt,
        error: "the deployment of 1.1.0 failed",
      },
    });
    expect(byId.get(envOf[did(CUSTOMER_2)]!)).toEqual({
      environmentId: envOf[did(CUSTOMER_2)],
      runningVersion: "1.0.0",
      isCanary: false,
      update: { status: "PENDING", toVersion: "1.1.0", dueAt, error: null },
    });
  });

  it("resume continues one environment at a time, and the rollout completes", async () => {
    const one = envOf[did(CUSTOMER_1)]!;
    const waiting = [envOf[did(CUSTOMER_2)]!, envOf[did(CUSTOMER_3)]!];
    const [rollout] = await rollouts.rolloutsOf(APP);
    await resumeRollout(service, { appId: APP, rolloutId: rollout!.id });
    // Both are due; only one moves per settled update.
    for (let round = 0; round < 2; round++) {
      await tick();
      const applying: string[] = [];
      for (const id of waiting)
        if ((await latestUpdate(id))?.status === "APPLYING") applying.push(id);
      expect(applying).toHaveLength(1);
      expect(await fusionVersion(applying[0]!)).toBe("1.1.0");
      for (const id of waiting.filter((w) => w !== applying[0])) {
        expect(await fusionVersion(id)).toBe("1.0.0");
        expect(await latestUpdate(id)).toMatchObject({ status: "PENDING" });
      }
      await deploy(applying[0]!);
      await tick();
      expect(await latestUpdate(applying[0]!)).toMatchObject({
        status: "SUCCEEDED",
      });
      waiting.splice(waiting.indexOf(applying[0]!), 1);
    }
    expect((await rollouts.rollout(rollout!.id))!.status).toBe("ACTIVE");
    // Someone fixes the failed environment: it redeploys and is READY on 1.1.0.
    await envs.execute(one, [setLabel({ label: "fixed" }), approveChanges({})]);
    await deploy(one);
    await tick();
    expect(await latestUpdate(one)).toMatchObject({ status: "SUCCEEDED" });
    // The customer who left never received it, and does not hold the rollout open.
    expect(await fusionVersion(envOf[did(LEAVER)]!)).toBe("1.0.0");
    expect((await rollouts.rollout(rollout!.id))!.status).toBe("COMPLETE");
    // Everything logged at warn over the whole run: the one failed release
    // step, the unreadable document, and the failed update with the pause
    // it caused. No version was stranded, so the gate held nothing with an
    // error.
    expect(logged).toStrictEqual({
      handler: [
        `[licensing] release work of app ${APP} failed: Error: rollout store down`,
      ],
      gate: [],
      tracker: [
        `[licensing] reading environment ${envOf[did(PUBLISHER)]} of app ${APP} failed; tracking it as not observed: Error: environment document read failed`,
        `[licensing] update of environment ${one} to FUSION 1.1.0 failed: the deployment of 1.1.0 failed`,
        `[licensing] rollout ${rollout!.id} of app ${APP} is paused until the publisher resumes it`,
      ],
      managedBy: [],
    });
  });
  it("customers asleep when a release is promoted catch up after it completes, one at a time", async () => {
    const canary = envOf[did(PUBLISHER)]!;
    const one = envOf[did(CUSTOMER_1)]!;
    const asleep = [envOf[did(CUSTOMER_2)]!, envOf[did(CUSTOMER_3)]!];
    await publish("1.3.0", "LATEST");
    await tick();
    expect(await fusionVersion(canary)).toBe("1.3.0");
    await deploy(canary);
    for (const id of asleep) await envs.execute(id, [sleepEnvironment({})]);
    const rollout = await promoteRelease(service, {
      appId: APP,
      artifactName: "web",
      version: "1.3.0",
      noticeHours: 0,
      promotedBy: PUBLISHER,
    });
    // The awake customer updates; the stopped ones cannot be provisioned,
    // and do not hold the rollout open.
    await applyOneAtATime(rollout.id, [one]);
    expect(await fusionVersion(one)).toBe("1.3.0");
    expect((await rollouts.rollout(rollout.id))!.status).toBe("COMPLETE");
    for (const id of asleep) {
      expect(await fusionVersion(id)).toBe("1.1.0");
      expect(await rollouts.updateFor(rollout.id, id)).toBeNull();
    }
    // Woken (and redeployed as they were): they catch up under the
    // COMPLETE rollout, one at a time.
    for (const id of asleep) {
      await envs.execute(id, [wakeEnvironment({})]);
      await deploy(id);
    }
    await applyOneAtATime(rollout.id, asleep);
    for (const id of asleep) {
      expect(await fusionVersion(id)).toBe("1.3.0");
      expect(await latestUpdate(id)).toMatchObject({
        rollout_id: rollout.id,
        status: "SUCCEEDED",
        from_version: "1.1.0",
        to_version: "1.3.0",
      });
    }
    expect((await rollouts.rollout(rollout.id))!.status).toBe("COMPLETE");
  });

  it("a customer whose chain ends during the notice and is resumed has its update revived and applied", async () => {
    const canary = envOf[did(PUBLISHER)]!;
    const customers = [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3].map(
      (c) => envOf[did(c)]!,
    );
    const one = customers[0]!;
    await publish("1.4.0", "LATEST");
    await tick();
    await deploy(canary);
    const rollout = await promoteRelease(service, {
      appId: APP,
      artifactName: "web",
      version: "1.4.0",
      noticeHours: 24,
      promotedBy: PUBLISHER,
    });
    await tickUntil(async () => {
      for (const id of customers)
        if ((await rollouts.updateFor(rollout.id, id))?.status !== "PENDING")
          return false;
      return true;
    });
    const waiting = (await rollouts.updateFor(rollout.id, one))!;
    expect(waiting.due_at).toBe(rollout.apply_after);
    // Its licence ends during the notice: the update is closed.
    const ending = (await rows()).find((r) => r.environment_id === one)!;
    await licenseGateway.execute(ending.license_id, [
      licenseActions.revokeLicense({ reason: "card declined" }),
    ]);
    await tick();
    expect(await rollouts.updateFor(rollout.id, one)).toMatchObject({
      status: "SUPERSEDED",
      error: "environment ended",
    });
    // Re-licensed on the same chain: it resumes, and its update is revived
    // with its deadline.
    await issueLicense(issueDeps, {
      appId: APP,
      user: did(CUSTOMER_1),
      kind: "pro",
      issuer: "PUBLISHER_GRANT",
      details: {},
      issuedBy: PUBLISHER,
      upgrades: ending.license_id,
      now: now(),
    });
    await tickUntil(
      async () =>
        (await rollouts.updateFor(rollout.id, one))?.status === "PENDING",
    );
    expect(
      (await rows()).find((r) => r.environment_id === one)!.ended_at,
    ).toBeNull();
    expect(await rollouts.updateFor(rollout.id, one)).toMatchObject({
      id: waiting.id,
      due_at: waiting.due_at,
      error: null,
      finished_at: null,
    });
    expect(await fusionVersion(one)).toBe("1.3.0");
    // Past the notice: all three apply, one at a time, and it completes.
    clock += 25 * HOUR;
    await applyOneAtATime(rollout.id, customers);
    for (const id of customers) expect(await fusionVersion(id)).toBe("1.4.0");
    expect(await rollouts.updateFor(rollout.id, one)).toMatchObject({
      id: waiting.id,
      status: "SUCCEEDED",
    });
    expect((await rollouts.rollout(rollout.id))!.status).toBe("COMPLETE");
  });
}, 300_000);
