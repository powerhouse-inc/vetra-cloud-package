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
import { createReactorEnvGateway } from "./envs.js";
import { createGithubDeployApi } from "./github.js";
import { createHarborApi } from "./harbor.js";
import { createRenownApi } from "./renown.js";
import type { AppsDeps } from "./service.js";
import {
  reportDeploymentToGithub,
  runDeploymentWatcherOnce,
  runPreviewSweepOnce,
  SWEEP_INTERVAL_MS,
  WATCH_INTERVAL_MS,
} from "./watcher.js";
import { handleGithubWebhook } from "./webhook.js";
import { createCiRoutes, createRenownCiVerifier } from "./ci.js";

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
    };
    deps.onDeploymentChanged = (id) => reportDeploymentToGithub(deps, id);

    this.resolvers = createResolvers(deps);

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
        this.http.get(
          "apps/ci/deployments/:id",
          { auth: "public" },
          (request, ctx) => ci.deployment(request, ctx.params.id ?? ""),
        ),
      );
    } catch (err) {
      console.warn(`[vetra-apps] CI routes not registered: ${String(err)}`);
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
    every(SWEEP_INTERVAL_MS, "preview sweeper", () =>
      runPreviewSweepOnce(deps),
    );
  }

  async onDisconnect() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const h of this.routeHandles) h.dispose();
    this.routeHandles = [];
  }
}
