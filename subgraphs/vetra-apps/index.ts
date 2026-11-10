import { randomUUID } from "node:crypto";
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { generateSubdomain } from "../../shared/subdomain-generator.js";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { VetraAppsDB } from "./db/schema.js";
import { loadAppsConfig, missingConfig } from "./config.js";
import { createReactorEnvGateway, subdomainTakenIn } from "./envs.js";
import type { DB as EnvironmentsDB } from "../../processors/vetra-cloud-environment/schema.js";
import { createGithubDeployApi } from "./github.js";
import { createHarborApi } from "./harbor.js";
import { createRenownApi } from "./renown.js";
import { applyQueuedDeployment, type AppsDeps } from "./service.js";
import { adoptPersonApps, appDocumentRowOwner } from "./org-ownership.js";
import { defaultRenownOrgs } from "../../shared/renown-orgs.js";
import { setPersonAppAdopter } from "../../shared/person-app-adoption.js";
import type { ObservabilityDB } from "../vetra-cloud-observability/db/schema.js";
import { backfillAppDocuments } from "./app-document.js";
import { createReactorAppDocStore } from "./app-doc-store.js";
import {
  createAppDocOwnerResolver,
  createAppDocProtector,
  protectAppDocument,
} from "./app-doc-protection.js";
import { studioPublisherAddress } from "../vetra-licensing/studio-app.js";
import {
  createAppLedger,
  ensureLedgerTables,
  lazyLedger,
  reactorLedgerSource,
} from "../vetra-licensing/licensing-ledger.js";
import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";
import {
  DRIFT_INTERVAL_MS,
  reportAppDocumentDrift,
} from "./app-document-drift.js";
import {
  reportDeploymentToGithub,
  reportPreviewRemovedToGithub,
  runDeploymentWatcherOnce,
  runIdentityExpirySweepOnce,
  runPreviewSweepOnce,
  runUnlaunchedStudioAppSweepOnce,
  SWEEP_INTERVAL_MS,
  WATCH_INTERVAL_MS,
} from "./watcher.js";
import { handleGithubWebhook } from "./webhook.js";
import { createCiRoutes, createRenownCiVerifier } from "./ci.js";
import { appMarksIn, candidatesIn, listDirectory } from "./directory.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import { createSecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";
import type { VetraGithubAuthDB } from "../vetra-github-auth/db/schema.js";
import { environmentConnections } from "../vetra-github-auth/db/installations.js";

/**
 * Vetra Apps: Git-connected apps with a production env and one preview env
 * per PR. Apps, previews and deployments are relational rows (namespace
 * "vetra-apps"); environments stay vetra-cloud-environment documents, linked
 * with the system-only SET_APP_LINK. Missing GitHub/Harbor/Renown config never
 * blocks loading: the affected resolvers answer SERVICE_NOT_CONFIGURED.
 */
export class VetraAppsSubgraph extends BaseSubgraph {
  name = "vetra-apps";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  private timers: ReturnType<typeof setInterval>[] = [];
  private routeHandles: { dispose(): void }[] = [];

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<VetraAppsDB>;
    await up(db as Kysely<any>);

    const cfg = loadAppsConfig(process.env);
    const missing = missingConfig(cfg);
    if (missing.length > 0) {
      console.warn(
        `[vetra-apps] not configured: ${missing.join(", ")} — affected features disabled`,
      );
    }

    // App documents are system-write-only: protect each one the moment it is
    // created. Without document permissions there is nothing to protect with.
    const perm = this.documentPermissionService;
    const appDocProtect = perm
      ? createAppDocProtector(
          perm,
          createAppDocOwnerResolver(
            appDocumentRowOwner(db),
            studioPublisherAddress(),
          ),
          this.reactorClient as never,
          console,
        )
      : undefined;

    // The app-state ledger lives in the "vetra-licensing" namespace
    // (app_licensing_state + app_licensing_intent). Every system write to an
    // app document from here records into it, so artifacts registered by CI
    // read as clean. Its tables are ensured here too because subgraph boot
    // order is not fixed. Initialised on first use and retried after a
    // failure: a ledger unreachable at boot is never disabled for good.
    const appLedger = lazyLedger(async () => {
      try {
        const ledgerDb = (await this.relationalDb.createNamespace(
          "vetra-licensing",
        )) as unknown as Kysely<VetraLicensingDB>;
        await ensureLedgerTables(ledgerDb as Kysely<any>);
        return createAppLedger({
          db: ledgerDb,
          source: reactorLedgerSource(this.reactorClient as never),
          now: () => new Date().toISOString(),
        });
      } catch (err) {
        console.error(
          `[vetra-apps] app-state ledger unavailable (retried on the next write): ${String(err)}`,
        );
        throw err;
      }
    });

    // Organisation moves of envs are announced in the observability namespace
    // (its tables are created by that subgraph; until it has booted a move
    // fails and is retried on the next read).
    const orgHandoverDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-observability",
    )) as unknown as Kysely<ObservabilityDB>;

    // A Studio's launch secret is written through the tenant secrets
    // (OpenBao transit); without OpenBao the rotation answers
    // SERVICE_NOT_CONFIGURED.
    const openbaoAddr = process.env.OPENBAO_ADDR;
    const studioSecrets = openbaoAddr
      ? createSecretsService({
          db: (await this.relationalDb.createNamespace(
            "vetra-cloud-secrets",
          )) as unknown as Kysely<SecretsDB>,
          transit: new OpenBaoTransitClient({
            addr: openbaoAddr,
            role: process.env.OPENBAO_TRANSIT_ROLE ?? "vetra-secrets",
            keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
          }),
        })
      : null;

    // The GitHub connections Studios made the old way (vetra-github-auth's
    // namespace, read only): a Studio's product carries that repository over
    // (adoptStudioRepository). Until that subgraph has booted the read fails
    // and is retried on the next push token request.
    const githubAuthDb = (await this.relationalDb.createNamespace(
      "vetra-github-auth",
    )) as unknown as Kysely<VetraGithubAuthDB>;

    const envReadModel = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<EnvironmentsDB>;
    const deps: AppsDeps = {
      db,
      envs: createReactorEnvGateway(this.reactorClient as never),
      cfg,
      github: cfg.github ? createGithubDeployApi(cfg.github) : null,
      harbor: cfg.harbor ? createHarborApi(cfg.harbor) : null,
      renown: cfg.renown ? createRenownApi(cfg.renown, cfg.renownWebUrl) : null,
      generateSubdomain,
      now: () => new Date(),
      newId: () => randomUUID(),
      logger: console,
      orgs: defaultRenownOrgs(),
      orgHandoverDb,
      studioSecrets,
      studioGithubConnections: (studioEnvironmentId) =>
        environmentConnections(githubAuthDb, studioEnvironmentId),
      // A product's <slug>.vetra.io must not collide with an env's hosts.
      subdomainTaken: subdomainTakenIn(envReadModel),
      protectAppDoc: perm
        ? (id, owner) => protectAppDocument(perm, id, owner)
        : null,
      docs: createReactorAppDocStore(
        this.reactorClient as never,
        appDocProtect,
        appLedger,
        console,
      ),
    };
    deps.onDeploymentChanged = (id) => reportDeploymentToGithub(deps, id);
    // A Studio launch/rollback is applied right after it was recorded (the
    // agent's request returns at once); the watcher picks up any it misses.
    deps.onDeploymentQueued = (id) => {
      void applyQueuedDeployment(deps, id).catch((err: unknown) =>
        console.warn(
          `[vetra-apps] applying deployment ${id} failed (the watcher retries): ${String(err)}`,
        ),
      );
    };
    deps.onPreviewRemoved = (app, preview, reason) =>
      reportPreviewRemovedToGithub(deps, app, preview, reason);

    this.resolvers = createResolvers(deps);
    // Licensing's personal app list adopts transferred Apps through us.
    setPersonAppAdopter((address) => adoptPersonApps(deps, address));

    // GitHub App webhook: /api/@powerhousedao/vetra-cloud-package/github/webhook
    try {
      const handle = this.http.post(
        "github/webhook",
        { auth: "public", body: "raw", maxBodyBytes: 5 * 1024 * 1024 },
        async (request, ctx) => {
          const result = await handleGithubWebhook(deps, {
            rawBody: ctx.rawBody,
            signature: request.headers.get("x-hub-signature-256"),
            event: request.headers.get("x-github-event"),
          });
          return result.body
            ? Response.json(result.body, { status: result.status })
            : new Response(null, { status: result.status });
        },
      );
      this.routeHandles.push(handle);
    } catch (err) {
      console.warn(`[vetra-apps] webhook route not registered: ${String(err)}`);
    }

    // CI routes (Renown workload tokens for VETRA_APPS_CI_AUDIENCE only):
    // /api/@powerhousedao/vetra-cloud-package/apps/ci/...
    try {
      const ci = createCiRoutes(
        deps,
        createRenownCiVerifier({
          audience: cfg.ciAudience,
          renownUrl: cfg.renownWebUrl,
        }),
      );
      const json = { auth: "public" as const, maxBodyBytes: 256 * 1024 };
      this.routeHandles.push(
        this.http.post("apps/ci/registry-credentials", json, (request) =>
          ci.registryCredentials(request),
        ),
        this.http.post("apps/ci/deploy", json, (request) => ci.deploy(request)),
        this.http.post("apps/ci/artifacts", json, (request) =>
          ci.artifacts(request),
        ),
        this.http.get(
          "apps/ci/deployments/:id",
          { auth: "public" },
          (request, ctx) => ci.deployment(request, ctx.params.id ?? ""),
        ),
      );
    } catch (err) {
      console.warn(`[vetra-apps] CI routes not registered: ${String(err)}`);
    }

    // Directory for an App's own site ("where does my <App> run?"): the
    // signed-in caller's environments running the App, never anyone else's.
    // /api/@powerhousedao/vetra-cloud-package/apps/directory/v1/environments?app=<id>
    try {
      const directory = {
        appMarks: appMarksIn(db, "cr.vetra.io"),
        candidates: candidatesIn(envReadModel),
        getState: (id: string) => deps.envs.getState(id),
        orgs: deps.orgs ?? null,
      };
      this.routeHandles.push(
        this.http.get(
          "apps/directory/v1/environments",
          { auth: "renown" },
          async (request, ctx) => {
            const appId = new URL(request.url).searchParams.get("app")?.trim();
            if (!appId)
              return Response.json(
                { error: "BAD_USER_INPUT", message: "app is required" },
                { status: 400 },
              );
            if (!ctx.user)
              return Response.json(
                { error: "UNAUTHENTICATED", message: "Sign in first" },
                { status: 401 },
              );
            try {
              const environments = await listDirectory(directory, ctx.user.address, appId);
              return Response.json(
                { environments },
                { headers: { "cache-control": "private, no-store" } },
              );
            } catch (err) {
              console.warn(`[vetra-apps] directory failed: ${String(err)}`);
              return Response.json(
                { error: "INTERNAL_SERVER_ERROR", message: "Internal error" },
                { status: 500 },
              );
            }
          },
        ),
      );
    } catch (err) {
      console.warn(`[vetra-apps] directory route not registered: ${String(err)}`);
    }

    const every = (ms: number, name: string, run: () => Promise<unknown>) => {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        run()
          .catch((err: unknown) =>
            console.warn(`[vetra-apps] ${name} failed: ${String(err)}`),
          )
          .finally(() => {
            busy = false;
          });
      }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(WATCH_INTERVAL_MS, "deployment watcher", () =>
      runDeploymentWatcherOnce(deps),
    );
    every(SWEEP_INTERVAL_MS, "preview sweeper", async () => {
      await runPreviewSweepOnce(deps);
      await runIdentityExpirySweepOnce(deps);
      await runUnlaunchedStudioAppSweepOnce(deps);
    });

    every(DRIFT_INTERVAL_MS, "app document drift", () =>
      reportAppDocumentDrift({ db, docs: deps.docs!, logger: console }),
    );

    // One document per app row. Idempotent: a row whose document exists is
    // skipped. Not awaited — reads are served from the table, so startup must
    // not wait on the reactor.
    void backfillAppDocuments({ db, docs: deps.docs!, logger: console })
      .then(({ created, skipped }) => {
        if (created > 0 || skipped > 0)
          console.info(
            `[vetra-apps] app documents: ${created} created, ${skipped} already present`,
          );
      })
      .catch((err: unknown) =>
        console.warn(
          `[vetra-apps] app document backfill failed: ${String(err)}`,
        ),
      );
  }

  async onDisconnect() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const h of this.routeHandles) h.dispose();
    this.routeHandles = [];
  }
}
