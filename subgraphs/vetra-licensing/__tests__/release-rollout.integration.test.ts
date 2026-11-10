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
import { markEnded, type OffboardingDeps } from "../offboarding.js";
import { createWarmPoolStore } from "../warm-pool-db.js";
import { createRolloutStore } from "../rollout-db.js";
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
 * environment and app documents, the production handler wiring (update gate,
 * release tracking and the managed-by marker through runAll, as index.ts
 * wires them with the keeper applying) and the release operations. Only
 * gitops and ArgoCD are played by the test (deploy / fail below).
 */
const APP = "5d2c1b7a-5d4f-4e6a-8b9c-0d1e2f3a4b6d";
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
  /** What the handler logs at warn (and error) level. */
  const handlerWarnings: string[] = [];
  /** Set for one tick: the tracker's environment reads fail. */
  let observabilityDown = false;

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
  const publish = (version: string, channel: "STAGING" | "LATEST") =>
    appDocs.execute(APP, [
      appActions.recordArtifactVersion({
        kind: "FUSION_IMAGE",
        name: "web",
        version,
        reference: ref(version),
        commitSha: null,
        runId: null,
        publishedAt: now(),
      }),
      appActions.setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: "web",
        channel,
        version,
      }),
    ]);

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
    envs = createReactorEnvGateway(client as never);
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
      createUpdateGate({ store: rollouts, logger: silent }),
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
    const markManaged = createManagedBySync({ envs, logger: silent });
    const releaseTracking: ReleaseTrackerDeps = {
      store: rollouts,
      envState: (id) =>
        observabilityDown
          ? Promise.reject(new Error("observability unreachable"))
          : envs.getState(id),
      cfg,
      logger: silent,
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
      onResumed: async () => {},
      afterChains: (app, after) =>
        runAll([
          () => trackReleases(releaseTracking, app, after),
          () => markManaged(app, after),
        ]),
      afterApp: async () => {},
      migrationComplete: async () => true,
      cfg,
      logger: {
        info: () => {},
        warn: (m: string) => {
          handlerWarnings.push(m);
        },
        error: (m: string) => {
          handlerWarnings.push(m);
        },
      },
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
    await publish("1.1.0", "STAGING");
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
  });

  it("a release step that fails does not stop the other, and is logged once", async () => {
    const canary = envOf[did(PUBLISHER)]!;
    await deploy(canary);
    // A holder joins on the tick the tracker cannot read the environments.
    await issue(LEAVER);
    observabilityDown = true;
    await tick();
    observabilityDown = false;
    const joined = (await rows()).find((r) => r.user_did === did(LEAVER))!;
    envOf[did(LEAVER)] = joined.environment_id;
    // The tracker failed: the canary's update is not settled yet...
    expect(await latestUpdate(canary)).toMatchObject({ status: "APPLYING" });
    // ...and the managed-by sync after it still marked the new environment.
    expect(
      (await envs.getState(joined.environment_id))!.managedBy,
    ).toMatchObject({ appId: APP, templateId: "host", services: ["FUSION"] });
    expect(handlerWarnings).toStrictEqual([
      `[licensing] release work of app ${APP} failed: Error: observability unreachable`,
    ]);
    await tick();
    expect(await latestUpdate(canary)).toMatchObject({ status: "SUCCEEDED" });
    expect(handlerWarnings).toHaveLength(1);
    await deploy(joined.environment_id);
    expect(await fusionVersion(joined.environment_id)).toBe("1.0.0");
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
    expect(handlerWarnings).toHaveLength(1);
  });
}, 300_000);
