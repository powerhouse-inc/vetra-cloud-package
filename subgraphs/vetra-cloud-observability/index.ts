import { resolve4 } from "node:dns/promises";
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { childLogger, createAction } from "document-model";
import { schema } from "./schema.js";
import { bumpEnvToTag, createResolvers } from "./resolvers.js";
import {
  createHarborArtifactLister,
  FUSION_AUTO_UPDATE_INTERVAL_MS,
  runFusionAutoUpdateOnce,
  type FusionEnvRow,
} from "./fusion-auto-update.js";
import { up } from "./db/migrations.js";
import { startWatchers, type WatcherHandle } from "./watchers.js";
import { ClintPullWorker } from "./clint-pull-worker.js";
import {
  environmentDocumentExists,
  reactorSnapshotMarkedDeleted,
} from "./env-existence.js";
import { DeployStuckTracker } from "./deploy-health.js";
import { DumpsRepo } from "./dumps/repo.js";
import { S3Helper } from "./dumps/s3.js";
import {
  createDefaultDumpsK8sClient,
  type DumpsK8sClient,
} from "./dumps/k8s-client.js";
import {
  createDefaultRestartK8sClient,
  type RestartResolverDeps,
} from "./restart.js";
import { reconcileJob } from "./dumps/watcher.js";
import type { DumpResolverDeps } from "./dumps/resolvers.js";
import type { ObservabilityDB } from "./db/schema.js";
import { coreServicesReady } from "./readiness.js";
import { appDidLookup, appDisputeLookup, createEnvAccess } from "./env-access.js";
import { defaultRenownOrgs } from "../../shared/renown-orgs.js";
import {
  orgProtectionOptions,
  resyncIfTampered,
  runOrgSyncOnce,
  skipWhileRunning,
  withEnvLock,
  type OrgSyncDeps,
} from "./org-sync.js";
import {
  envChangeProtector,
  protectEnvironment,
  vetraServiceAddress,
  type EnvProtectionTarget,
} from "./env-protection.js";

export class VetraCloudObservabilitySubgraph extends BaseSubgraph {
  name = "vetra-cloud-observability";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  private watcherHandle: WatcherHandle | null = null;
  private deploymentReconciler: ReturnType<typeof setInterval> | null = null;
  private ownerBackfill: ReturnType<typeof setInterval> | null = null;
  private orgOperatorSync: ReturnType<typeof setInterval> | null = null;
  private protectionReconciler: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEnvProtection: (() => void) | null = null;
  /** Operation restrictions this process already applied (see env-protection.ts). */
  private readonly restrictedEnvOps = new Set<string>();
  private challengeReconciler: ReturnType<typeof setInterval> | null = null;
  private releaseIndexBackfill: ReturnType<typeof setInterval> | null = null;
  private fusionAutoUpdate: ReturnType<typeof setInterval> | null = null;
  private clintPullWorker: ClintPullWorker | null = null;
  private dumpJobWatcher: ReturnType<typeof setInterval> | null = null;
  private dumpRowPruner: ReturnType<typeof setInterval> | null = null;
  private dumpsK8s: DumpsK8sClient | null = null;
  private dumpsRepo: DumpsRepo | null = null;
  private dumpsS3: S3Helper | null = null;

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-observability",
    )) as unknown as Kysely<ObservabilityDB>;

    await up(db as Kysely<any>);

    const prometheusUrl =
      process.env.PROMETHEUS_URL ??
      "http://kube-prometheus-stack-prometheus.monitoring.svc:9090";
    const lokiUrl = process.env.LOKI_URL ?? "http://loki.monitoring.svc:3100";

    // The processor's `environments` table lives in a separate namespace.
    // The `myEnvironments` / `viewer` resolvers read from it.
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<any>;

    // Organisation access: Renown memberships + app DIDs from the vetra-apps namespace.
    const appsDb = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<any>;
    const access = createEnvAccess({
      orgs: defaultRenownOrgs(),
      appDidOf: appDidLookup(appsDb),
      appOrgDisputed: appDisputeLookup(appsDb),
    });

    const dispatch = async (
      documentId: string,
      type: string,
      input: Record<string, unknown>,
    ) => {
      const action = createAction(type, input);
      await this.reactorClient.execute(documentId, "main", [action]);
    };

    // Organisation operator sync. The dispatch is in-process, so its actions
    // are system-signed. Without a permission service (set in the subgraph
    // constructor) only orgOperators are synced, no document grants.
    const orgSync: OrgSyncDeps = {
      envDb,
      db,
      orgs: defaultRenownOrgs(),
      appDidOf: appDidLookup(appsDb),
      appOrgDisputed: appDisputeLookup(appsDb),
      dispatch,
      perm: this.documentPermissionService ?? null,
      serviceOwner: vetraServiceAddress(),
      restricted: this.restrictedEnvOps,
      readOrgState: async (documentId) => {
        const doc = await this.reactorClient.get(documentId);
        const state = (doc as { state?: { global?: Record<string, unknown> } }).state?.global ?? {};
        const operators = state.orgOperators;
        return {
          owner: typeof state.owner === "string" ? state.owner : null,
          ownerOrgId: typeof state.ownerOrgId === "string" ? state.ownerOrgId : null,
          orgOperators: Array.isArray(operators) ? operators.filter((o): o is string => typeof o === "string") : [],
        };
      },
      logger: console,
    };

    const dumpDeps = await this.buildDumpDeps(db, envDb);

    // Restart feature: build the in-cluster Deployments client. If it can't
    // be constructed (e.g. running outside a cluster), the resolver throws
    // RESTART_NOT_CONFIGURED rather than failing schema validation.
    let restartDeps: RestartResolverDeps | undefined;
    try {
      restartDeps = { envDb, k8s: await createDefaultRestartK8sClient(), access };
    } catch (err) {
      console.warn(
        "[observability] restart: kubernetes client init failed — restart disabled:",
        err,
      );
    }

    this.resolvers = createResolvers(db, {
      prometheusUrl,
      lokiUrl,
      envDb,
      dispatch,
      dumpDeps: dumpDeps ?? undefined,
      restartDeps,
      access,
      orgSync,
    });

    // FUSION auto-deploy: follow the newest matching Harbor tag per env.
    // Needs a Harbor reader robot; without it the feature is simply off.
    const harborUser = process.env.HARBOR_FUSION_READER_USERNAME;
    const harborPass = process.env.HARBOR_FUSION_READER_PASSWORD;
    if (harborUser && harborPass) {
      const listArtifacts = createHarborArtifactLister({
        username: harborUser,
        password: harborPass,
      });
      const tick = async () => {
        try {
          const bumped = await runFusionAutoUpdateOnce({
            listEnvs: async () =>
              (await envDb
                .selectFrom("environments")
                .select(["id", "name", "tenantId", "status", "services", "fusion", "appId"])
                .where("fusion", "is not", null)
                .where("appId", "is", null)
                .execute()) as FusionEnvRow[],
            listArtifacts,
            bump: (env, tag) =>
              bumpEnvToTag(
                { db, envDb, dispatch },
                env,
                new Set(["FUSION"]),
                tag,
                "AUTO",
                "FUSION",
                "",
              ),
          });
          if (bumped.length > 0)
            console.info(`[fusion-auto-update] bumped ${bumped.join(", ")}`);
        } catch (err) {
          console.warn(`[fusion-auto-update] tick failed: ${String(err)}`);
        }
      };
      this.fusionAutoUpdate = setInterval(() => void tick(), FUSION_AUTO_UPDATE_INTERVAL_MS);
    }

    if (dumpDeps && process.env.VETRA_DUMPS_WATCHER_ENABLED !== "false") {
      this.startDumpJobWatcher();
      this.startDumpRowPruner();
      console.info("[observability] DumpJobWatcher started (10s tick)");
    } else {
      console.info(
        `[observability] DumpJobWatcher NOT started (dumpDeps=${!!dumpDeps}, VETRA_DUMPS_WATCHER_ENABLED=${process.env.VETRA_DUMPS_WATCHER_ENABLED ?? "(unset)"})`,
      );
    }

    // Start watchers using the pod's in-cluster ServiceAccount.
    //
    // We used to acquire a short-lived K8s token via OpenBao's Kubernetes
    // secrets engine, but that path is broken for cluster-scoped resources:
    // OpenBao creates a namespaced RoleBinding (even when the role is set to
    // `kubernetes_role_type: ClusterRole`) referencing the ClusterRole, which
    // is equivalent to a Role and does NOT grant cluster-wide list permission
    // on `applications.argoproj.io`. The pod's default SA already has the
    // correct ClusterRoleBinding (`staging-observability` / `vetra-observability`
    // in infrastructure/vetra-observability-rbac/rbac.yaml), so loading from
    // the pod environment is both simpler and strictly more permissive.
    //
    // Passing an empty token triggers `kc.loadFromCluster()` inside the
    // watchers (see watchers.ts). Leaving OPENBAO_ADDR configured is fine —
    // the secrets subgraph still uses it for KV v2 access.
    try {
      this.watcherHandle = startWatchers({
        db,
        envDb,
        k8sToken: "",
      });
      console.info("[observability] Watchers started (in-cluster SA)");
    } catch (err) {
      console.warn("[observability] Failed to start watchers:", err);
    }

    // Start deployment reconciler: bridges ArgoCD status → document status
    this.startDeploymentReconciler(db);

    // Start owner backfill: assigns state.owner on historical envs from createdBy.
    // Idempotent — skips rows that already have owner set or no createdBy.
    this.startOwnerBackfill();

    // Organisation operators: refresh orgOperators and document grants from Renown.
    this.startOrgOperatorSync(orgSync);

    // Start protection reconciler: for each owned env, ensure the document is
    // marked "protected" at the reactor-api layer and the owner has an ADMIN
    // permission grant. This is what locks down direct getDocument(id) reads
    // for non-owner, non-admin users.
    this.startProtectionReconciler(orgSync);

    // …and immediately on every change of an environment document, so a
    // newly owned or organisation-owned env has no unprotected window.
    this.startEnvProtectionHook(orgSync);

    // Start stuck-challenge reconciler: rescues cert-manager Certificates
    // whose latest HTTP-01 Challenge went invalid due to NXDOMAIN (the
    // classic "cert-manager raced external-dns on first provision") by
    // deleting the Certificate once DNS now resolves to us.
    this.startChallengeReconciler();

    // Start release-index backfill: keeps the release_index table
    // populated from npm dist-tags so the UI's "latest on channel"
    // display and the update-now mutation have data even when the
    // subgraph hasn't received a notifyNewImageRelease webhook for that
    // channel yet.
    this.startReleaseIndexBackfill(db);

    // Pull-based CLINT endpoint discovery. Replaces the legacy push-announce
    // path — agents serve their endpoints at `/clint/endpoints`; we GET on a
    // 15s tick and upsert into clint_runtime_endpoints. Gated behind a flag
    // until the ph-clint nginx version is rolled out everywhere.
    if (process.env.CLINT_PULL_WORKER_ENABLED === "true") {
      try {
        this.clintPullWorker = new ClintPullWorker({
          envDb,
          obsDb: db,
          logger: childLogger(["observability", "clint-pull-worker"]),
          // Advance a CLINT service PROVISIONING → ACTIVE once its website
          // endpoint is discovered, so the cold-create (BYOK) provisioning UI
          // completes instead of spinning forever.
          dispatch,
          // After 3 failed polls: is the env document still there? A row that
          // outlived its document is removed so it stops being polled.
          // Gone = positive deletion evidence in the reactor's DocumentSnapshot
          // (every delete is a soft delete, invisible to get() while
          // REACTOR_DOCUMENT_DECISIONS is off), or no operation stream at all.
          // Anything uncertain keeps the record. The processor db is the same
          // Postgres as the reactor's; if it isn't, the query throws → keep.
          documentExists: (documentId, signal) =>
            environmentDocumentExists(this.reactorClient, documentId, signal, {
              isMarkedDeleted: (id) =>
                reactorSnapshotMarkedDeleted(
                  this.relationalDb as unknown as Kysely<any>,
                  id,
                ),
            }),
        });
        this.clintPullWorker.start();
        console.info("[observability] ClintPullWorker started");
      } catch (err) {
        console.warn("[observability] Failed to start ClintPullWorker:", err);
      }
    }
  }

  async onDisconnect() {
    this.watcherHandle?.stop();
    this.watcherHandle = null;
    if (this.deploymentReconciler) {
      clearInterval(this.deploymentReconciler);
      this.deploymentReconciler = null;
    }
    if (this.ownerBackfill) {
      clearInterval(this.ownerBackfill);
      this.ownerBackfill = null;
    }
    if (this.orgOperatorSync) {
      clearInterval(this.orgOperatorSync);
      this.orgOperatorSync = null;
    }
    if (this.protectionReconciler) {
      clearInterval(this.protectionReconciler);
      this.protectionReconciler = null;
    }
    this.unsubscribeEnvProtection?.();
    this.unsubscribeEnvProtection = null;
    if (this.challengeReconciler) {
      clearInterval(this.challengeReconciler);
      this.challengeReconciler = null;
    }
    if (this.fusionAutoUpdate) {
      clearInterval(this.fusionAutoUpdate);
      this.fusionAutoUpdate = null;
    }
    if (this.releaseIndexBackfill) {
      clearInterval(this.releaseIndexBackfill);
      this.releaseIndexBackfill = null;
    }
    if (this.dumpJobWatcher) {
      clearInterval(this.dumpJobWatcher);
      this.dumpJobWatcher = null;
    }
    if (this.dumpRowPruner) {
      clearInterval(this.dumpRowPruner);
      this.dumpRowPruner = null;
    }
    this.clintPullWorker?.stop();
    this.clintPullWorker = null;
  }

  /**
   * Build the dump-feature dependencies. Returns null when S3
   * credentials aren't configured so the rest of the subgraph still
   * boots — the dump query/mutation simply aren't registered.
   */
  private async buildDumpDeps(
    db: Kysely<ObservabilityDB>,
    envDb: Kysely<any>,
  ): Promise<DumpResolverDeps | null> {
    const accessKey = process.env.VETRA_DUMPS_S3_ACCESS_KEY;
    const secretKey = process.env.VETRA_DUMPS_S3_SECRET_KEY;
    if (!accessKey || !secretKey) {
      console.warn(
        "[observability] dumps: S3 credentials missing — dump feature disabled",
      );
      return null;
    }

    const repo = new DumpsRepo(db);
    let k8s: DumpsK8sClient;
    try {
      k8s = await createDefaultDumpsK8sClient();
    } catch (err) {
      console.warn(
        "[observability] dumps: kubernetes client init failed — dump feature disabled:",
        err,
      );
      return null;
    }
    const s3 = new S3Helper({
      endpoint:
        process.env.VETRA_DUMPS_S3_ENDPOINT ??
        "https://fsn1.your-objectstorage.com",
      region: process.env.VETRA_DUMPS_S3_REGION ?? "fsn1",
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      bucket: process.env.VETRA_DUMPS_BUCKET ?? "powerhouse-env-dumps",
    });

    this.dumpsRepo = repo;
    this.dumpsK8s = k8s;
    this.dumpsS3 = s3;

    return {
      repo,
      envDb,
      createJob: (ns, body) => k8s.createJob(ns, body),
      deleteJob: (ns, name) => k8s.deleteJob(ns, name),
      presign: (key) => s3.presignDownload(key),
      deleteObject: (key) => s3.deleteObject(key),
      image:
        process.env.VETRA_DUMPS_IMAGE ??
        "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0",
      bucket: process.env.VETRA_DUMPS_BUCKET ?? "powerhouse-env-dumps",
      s3Endpoint:
        process.env.VETRA_DUMPS_S3_ENDPOINT ??
        "https://fsn1.your-objectstorage.com",
      s3AccessKey: accessKey,
      s3SecretKey: secretKey,
    };
  }

  /**
   * Periodically reconciles in-flight dump rows against their k8s
   * Jobs. List the cluster's managed Jobs once per tick and look up
   * each in-flight row by its dump-id label, so subgraph restarts
   * resume cleanly.
   */
  private startDumpJobWatcher() {
    const tick = async () => {
      const repo = this.dumpsRepo;
      const k8s = this.dumpsK8s;
      const s3 = this.dumpsS3;
      if (!repo || !k8s || !s3) {
        console.warn(
          `[dump-job-watcher] tick aborted: repo=${!!repo} k8s=${!!k8s} s3=${!!s3}`,
        );
        return;
      }
      try {
        const inFlight = await repo.listInFlight();
        if (inFlight.length === 0) return;
        console.info(
          `[dump-job-watcher] tick: ${inFlight.length} in-flight dump(s)`,
        );
        const managed = await k8s.listManagedJobs();
        console.info(
          `[dump-job-watcher] cluster reports ${managed.length} managed Job(s): ${managed.map((j) => j.dumpId).join(",")}`,
        );
        const byDumpId = new Map<string, { namespace: string; name: string }>();
        for (const j of managed) {
          byDumpId.set(j.dumpId, { namespace: j.namespace, name: j.name });
        }

        for (const dump of inFlight) {
          const ref = byDumpId.get(dump.id);
          if (!ref) {
            // Two cases produce a missing Job ref:
            //
            // 1. Race: the resolver has just inserted the row but
            //    `setJobName` hasn't run yet (or `createJob` failed
            //    before it could). `jobName` is still null.
            // 2. Orphan: the row had a Job that's now gone — manually
            //    deleted, evicted, or the cluster lost it. `jobName`
            //    is set but no managed Job carries that label.
            //
            // We only act on case 2. Case 1 resolves itself on the
            // next tick or via the resolver's catch path (markFailed
            // on createJob error).
            if (dump.jobName) {
              await repo.markFailed(
                dump.id,
                `Job "${dump.jobName}" no longer exists in namespace ${dump.tenantId}; orphaned dump marked failed.`,
                new Date(),
              );
            }
            continue;
          }
          const status = await k8s.readJobStatus(ref.namespace, ref.name);
          if (!status) continue;
          const podPhase = await k8s.readPodPhaseForJob(
            ref.namespace,
            ref.name,
          );
          await reconcileJob({
            repo,
            dumpId: dump.id,
            jobName: ref.name,
            jobStatus: status,
            podPhase,
            now: new Date(),
            headSize: (key) => s3.headSize(key),
            readPodLogs: () =>
              k8s.readPodLogsForJob(ref.namespace, ref.name),
          });
        }
      } catch (err) {
        console.warn("[dump-job-watcher] error:", err);
      }
    };
    // 10s tick — same cadence as deployment reconciler
    this.dumpJobWatcher = setInterval(() => void tick(), 10_000);
    void tick();
  }

  /** Hourly sweep that drops dump rows older than 7 days. The S3 file
   *  itself expires at 24h via bucket lifecycle; we keep the row
   *  visible for a week so users see "expired" history rather than
   *  silently disappearing dumps. */
  private startDumpRowPruner() {
    const tick = async () => {
      const repo = this.dumpsRepo;
      if (!repo) return;
      try {
        const removed = await repo.pruneExpired(new Date());
        if (removed > 0) {
          console.info(`[dump-row-pruner] pruned ${removed} row(s)`);
        }
      } catch (err) {
        console.warn("[dump-row-pruner] error:", err);
      }
    };
    this.dumpRowPruner = setInterval(() => void tick(), 60 * 60 * 1000);
  }

  /** Grace period (ms) before marking a DEPLOYING environment as failed.
   *  Services like switchboard need time for image pulls, migrations, and
   *  health-probe warm-up — ArgoCD will report DEGRADED during this window. */
  private static DEPLOYMENT_GRACE_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Periodically checks for environments in CHANGES_PUSHED/DEPLOYING status
   * and transitions them to READY/FAILED based on ArgoCD state.
   *
   * Queries the processor's environments table (via a shared DB namespace)
   * and the observability environment_status table.
   */
  private startDeploymentReconciler(observabilityDb: Kysely<ObservabilityDB>) {
    const stuckTracker = new DeployStuckTracker();
    const reconcile = async () => {
      try {
        // Get the processor's environments namespace to read document states
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        // Find environments waiting for deployment
        const pendingEnvs = (await envDb
          .selectFrom("environments")
          .select(["id", "tenantId", "status", "name", "deployingSince", "services"])
          .where("status", "in", ["CHANGES_PUSHED", "DEPLOYING"])
          .execute()) as Array<{
          id: string;
          tenantId: string | null;
          status: string;
          name: string | null;
          deployingSince: string | null;
          services: unknown;
        }>;

        // Deploys pending for more than 15 min: one error per stuck episode.
        for (const env of stuckTracker.newlyStuck(pendingEnvs, Date.now())) {
          console.error(
            `[deployment-reconciler] ${env.name ?? env.id} (${env.id}): stuck in ${env.status} ` +
              `for ${Math.round(env.stuckForMs / 60_000)} min`,
          );
        }

        if (pendingEnvs.length === 0) return;

        for (const env of pendingEnvs) {
          if (!env.tenantId) continue;

          // Check ArgoCD status for this tenant
          const argoStatus = await observabilityDb
            .selectFrom("environment_status")
            .select(["argoSyncStatus", "argoHealthStatus", "argoLastSyncedAt"])
            .where("tenantId", "=", env.tenantId)
            .executeTakeFirst();

          if (!argoStatus) continue;

          const label = env.name ?? env.id;
          const { argoSyncStatus, argoHealthStatus, argoLastSyncedAt } = argoStatus;

          if (env.status === "CHANGES_PUSHED") {
            // Always transition to DEPLOYING on first sighting — do NOT
            // fast-path to READY based on argo health, because the cached
            // argo status at this point is almost always stale from *before*
            // our gitops push. Requiring argo to reconcile the new revision
            // before marking READY is the whole point of the DEPLOYING state.
            console.info(
              `[deployment-reconciler] ${label}: CHANGES_PUSHED → DEPLOYING (health: ${argoHealthStatus}, sync: ${argoSyncStatus})`,
            );
            const now = new Date().toISOString();
            await envDb
              .updateTable("environments")
              .set({ deployingSince: now })
              .where("id", "=", env.id)
              .execute();
            await this.dispatchAction(env.id, "MARK_DEPLOYMENT_STARTED", {});
          } else if (env.status === "DEPLOYING") {
            // Trust argo's verdict once we have evidence it has observed our
            // gitops push. Signals are:
            //   • argoLastSyncedAt (reconciledAt) > deployingSince — the
            //     strong case, argo explicitly saw the new revision.
            //   • 30s have elapsed since deployingSince — belt-and-suspenders
            //     for cases where argo's timestamps don't obviously advance
            //     (e.g. a push that renders identical manifests), which
            //     otherwise keeps the env pinned in DEPLOYING forever.
            const deployingSinceMs = env.deployingSince
              ? new Date(env.deployingSince).getTime()
              : 0;
            const argoSyncedMs = argoLastSyncedAt
              ? new Date(argoLastSyncedAt).getTime()
              : 0;
            const argoSawChange = argoSyncedMs > deployingSinceMs;
            const elapsedMs = deployingSinceMs
              ? Date.now() - deployingSinceMs
              : Infinity;
            const GRACE_FALLBACK_MS = 30_000;
            const trustworthy = argoSawChange || elapsedMs > GRACE_FALLBACK_MS;

            if (!trustworthy) {
              console.info(
                `[deployment-reconciler] ${label}: DEPLOYING, waiting for ArgoCD to reconcile ` +
                  `(argoLastSyncedAt=${argoLastSyncedAt ?? "null"}, ` +
                  `deployingSince=${env.deployingSince ?? "null"}, elapsed=${Math.round(elapsedMs / 1000)}s)`,
              );
              continue;
            }

            // Fast path: mark READY as soon as the workload pods are actually
            // ready, instead of waiting for ArgoCD's slower health aggregation
            // (which lags pod readiness by ~15-30s). The pod watcher already
            // tracks readiness event-driven in environment_pods. Guarded by the
            // `trustworthy` check above, so we never act on pods from a previous
            // revision before ArgoCD has applied the new one.
            const pods = await observabilityDb
              .selectFrom("environment_pods")
              .select(["ready", "phase"])
              .where("tenantId", "=", env.tenantId)
              .execute();
            if (coreServicesReady(env.services, pods)) {
              console.info(
                `[deployment-reconciler] ${label}: DEPLOYING → READY (pods ready: ${pods.length})`,
              );
              await envDb
                .updateTable("environments")
                .set({ deployingSince: null })
                .where("id", "=", env.id)
                .execute();
              await this.dispatchAction(
                env.id,
                "REPORT_DEPLOYMENT_SUCCEEDED",
                {},
              );
              continue;
            }

            if (argoHealthStatus === "HEALTHY") {
              console.info(
                `[deployment-reconciler] ${label}: DEPLOYING → READY (healthy)`,
              );
              await envDb
                .updateTable("environments")
                .set({ deployingSince: null })
                .where("id", "=", env.id)
                .execute();
              await this.dispatchAction(
                env.id,
                "REPORT_DEPLOYMENT_SUCCEEDED",
                {},
              );
            } else if (argoHealthStatus === "DEGRADED") {
              const deployingSince = env.deployingSince
                ? new Date(env.deployingSince).getTime()
                : Date.now();

              // Backfill deployingSince if missing (e.g. environments already
              // DEPLOYING before this code was deployed)
              if (!env.deployingSince) {
                await envDb
                  .updateTable("environments")
                  .set({ deployingSince: new Date().toISOString() })
                  .where("id", "=", env.id)
                  .execute();
              }

              const elapsed = Date.now() - deployingSince;
              if (elapsed < VetraCloudObservabilitySubgraph.DEPLOYMENT_GRACE_MS) {
                console.info(
                  `[deployment-reconciler] ${label}: DEPLOYING, health DEGRADED — ` +
                  `waiting (${Math.round(elapsed / 1000)}s / ${VetraCloudObservabilitySubgraph.DEPLOYMENT_GRACE_MS / 1000}s grace)`,
                );
              } else {
                // A failed deploy is what operators need to see: error level
                // (prod logs at warn). Logged once — the env leaves DEPLOYING.
                console.error(
                  `[deployment-reconciler] ${label} (${env.id}): → DEPLOYMENT_FAILED (${argoHealthStatus}, ` +
                  `grace period exceeded after ${Math.round(elapsed / 1000)}s)`,
                );
                await envDb
                  .updateTable("environments")
                  .set({ deployingSince: null })
                  .where("id", "=", env.id)
                  .execute();
                const reported = await this.dispatchAction(env.id, "REPORT_DEPLOYMENT_FAILED", {
                  code: argoHealthStatus,
                  message: `ArgoCD health: ${argoHealthStatus}, sync: ${argoSyncStatus}`,
                });
                if (!reported) {
                  console.error(
                    `[deployment-reconciler] ${label} (${env.id}, tenant ${env.tenantId}): ` +
                      `failed to record DEPLOYMENT_FAILED (ArgoCD health: ${argoHealthStatus}, sync: ${argoSyncStatus}); ` +
                      `retried after another grace period while still degraded`,
                  );
                }
              }
            } else if (argoHealthStatus === "MISSING") {
              // MISSING is expected for new tenants — ArgoCD hasn't synced yet
              console.info(
                `[deployment-reconciler] ${label}: waiting (ArgoCD health: MISSING)`,
              );
            } else if (argoHealthStatus === "PROGRESSING") {
              console.info(
                `[deployment-reconciler] ${label}: waiting (ArgoCD health: PROGRESSING)`,
              );
            }
          }
        }
      } catch (err) {
        // Don't log on every tick if the processor table doesn't exist yet
        if (String(err).includes("does not exist")) return;
        console.warn("[deployment-reconciler] error:", err);
      }
    };

    // Run every 10 seconds — UI reflects status transitions within 10s of
    // the argo-side change (argo itself reacts to git pushes in ~1s via the
    // github webhook, so this is the dominant user-facing delay).
    this.deploymentReconciler = setInterval(() => void reconcile(), 10_000);
    // Run once immediately
    void reconcile();
  }

  /**
   * Every 5 minutes: recompute orgOperators of every organisation env from
   * Renown and reconcile the document grants Vetra made. A Renown outage
   * leaves documents and grants untouched (see org-sync.ts).
   */
  private startOrgOperatorSync(orgSync: OrgSyncDeps) {
    const syncOrgs = skipWhileRunning(async () => {
      try {
        const n = await runOrgSyncOnce(orgSync);
        if (n > 0) console.info(`[org-sync] checked ${n} organisation environment(s)`);
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[org-sync] error:", err);
      }
    });
    this.orgOperatorSync = setInterval(() => void syncOrgs(), 5 * 60 * 1000);
    void syncOrgs();
  }

  /**
   * Seeds state.owner on historical environments by dispatching a system-signed
   * SET_OWNER action with the address from the processor's createdBy column.
   *
   * Why this works without forging signatures:
   *   The SET_OWNER reducer allows system-signed actions (no user in the signer)
   *   to set any address when state.owner is null. User-signed claims are still
   *   restricted to the signer's own address.
   *
   * Idempotent — skips rows where owner is already set or createdBy is null.
   * Runs on startup and every 5 minutes as a safety net in case a dispatch
   * failed (e.g., document was locked).
   */
  private startOwnerBackfill() {
    const backfill = async () => {
      try {
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        const pending = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "createdBy"])
          .where("owner", "is", null)
          .where("createdBy", "is not", null)
          .execute()) as Array<{
          id: string;
          name: string | null;
          createdBy: string;
        }>;

        if (pending.length === 0) return;

        console.info(
          `[owner-backfill] Seeding owner for ${pending.length} env(s)`,
        );

        for (const env of pending) {
          // dispatchAction swallows errors; individual failures log but don't
          // abort the batch. Next tick will re-attempt anything still missing.
          await this.dispatchAction(
            env.id,
            "SET_OWNER",
            { address: env.createdBy },
            "owner-backfill",
          );
        }
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[owner-backfill] error:", err);
      }
    };

    // Run every 5 minutes as a safety net, plus once on startup.
    this.ownerBackfill = setInterval(() => void backfill(), 5 * 60 * 1000);
    void backfill();
  }

  /**
   * Enforces reactor-api protection for every environment document (see
   * env-protection.ts):
   *   - personal env: protected, owner = env owner (+ ADMIN grant);
   *   - organisation env: protected, owner = the Vetra service identity, no
   *     ADMIN grants (the creator reaches it only through operator grants);
   *   - every env: the operations whose only gate is "system" are restricted
   *     (on unowned envs only the organisation ones: SET_OWNER stays open so
   *     a user can claim it).
   * Every 60 s and on startup, as a safety net for startEnvProtectionHook.
   */
  private startProtectionReconciler(orgSync: OrgSyncDeps) {
    const reconcile = async () => {
      const perm = this.documentPermissionService;
      if (!perm) return;

      try {
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        // Read-model rows may be stale; protectEnvironment re-reads the
        // document whenever a stale row could undo or fake a hand-over.
        const envs = (await envDb
          .selectFrom("environments")
          .select(["id", "owner", "ownerOrgId"])
          .execute()) as EnvProtectionTarget[];

        let failed = 0;
        for (const row of envs) {
          try {
            await this.protectEnv(orgSync, row);
          } catch (err) {
            failed++;
            console.warn(`[protection-reconciler] ${row.id}: ${String(err)}`);
          }
        }
        if (failed > 0) console.warn(`[protection-reconciler] ${failed}/${envs.length} env(s) failed`);
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[protection-reconciler] error:", err);
      }
    };

    // Every 60s + once on startup.
    this.protectionReconciler = setInterval(
      () => void reconcile(),
      60 * 1000,
    );
    void reconcile();
  }

  /** Protects an environment document as soon as it is created or changes. */
  private startEnvProtectionHook(orgSync: OrgSyncDeps) {
    this.unsubscribeEnvProtection = this.reactorClient.subscribe(
      { type: "powerhouse/vetra-cloud-environment" },
      envChangeProtector(async (env) => {
        const result = await this.protectEnv(orgSync, env);
        // SYNC_ORG_OPERATORS from anywhere but the sync → recompute from Renown.
        if (result === "ORG" && (await resyncIfTampered(orgSync, env))) {
          console.warn(`[env-protection] ${env.id}: operators changed outside the sync; resynced`);
        }
      }, console),
    );
  }

  private async protectEnv(orgSync: OrgSyncDeps, env: EnvProtectionTarget) {
    const perm = orgSync.perm;
    if (!perm) return null;
    return withEnvLock(env.id, () => protectEnvironment(perm, env, orgProtectionOptions(orgSync)));
  }

  private async dispatchAction(
    documentId: string,
    type: string,
    input: Record<string, unknown>,
    logTag: string = "deployment-reconciler",
  ): Promise<boolean> {
    try {
      const action = createAction(type, input);
      await this.reactorClient.execute(documentId, "main", [action]);
      console.info(`[${logTag}] Dispatched ${type} for ${documentId}`);
      return true;
    } catch (err) {
      console.error(
        `[${logTag}] Failed to dispatch ${type} for ${documentId}: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * Rescues cert-manager certs whose HTTP-01 Challenge lost the first-provision
   * race against external-dns. The flow is:
   *
   *   1. list every Challenge cluster-wide whose `status.state == "invalid"`
   *      AND whose reason mentions NXDOMAIN (the specific race we solve here,
   *      not e.g. webhook failures or network errors)
   *   2. for each, resolve4 the challenge's dnsName; if it now returns one of
   *      the cluster's LB IPs, DNS has caught up
   *   3. throttle via the `vetra.io/last-retry` annotation on the owning
   *      Certificate — skip if we already retried within LAST_RETRY_COOLDOWN
   *   4. delete the Certificate; cert-manager's Ingress-shim re-creates it
   *      on the next reconcile with a fresh Order, which now passes the
   *      HTTP-01 challenge
   *
   * With DNS-01 enabled for *.vetra.io this path shouldn't fire for our own
   * tenants; it exists for external customer domains that stay on HTTP-01.
   */
  private static CLUSTER_LB_IPS = new Set<string>([
    "138.199.129.93",
    // IPv6 equivalent lives on the same LB; resolve4 won't return it, but
    // leave it here for future documentation.
    "2a01:4f8:c01e:796::1",
  ]);
  private static LAST_RETRY_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
  private static LAST_RETRY_ANNOTATION = "vetra.io/last-retry";

  private startChallengeReconciler() {
    const reconcile = async () => {
      try {
        const { KubeConfig, CustomObjectsApi } = await import(
          "@kubernetes/client-node"
        );
        const kc = new KubeConfig();
        kc.loadFromCluster();
        const customApi = kc.makeApiClient(CustomObjectsApi);

        // List all invalid Challenges cluster-wide.
        const res = (await customApi.listClusterCustomObject({
          group: "acme.cert-manager.io",
          version: "v1",
          plural: "challenges",
        })) as {
          items?: Array<{
            metadata?: {
              name?: string;
              namespace?: string;
              ownerReferences?: Array<{ kind?: string; name?: string }>;
            };
            spec?: { dnsName?: string };
            status?: { state?: string; reason?: string };
          }>;
        };

        const stuck = (res.items ?? []).filter(
          (c) =>
            c.status?.state === "invalid" &&
            (c.status?.reason ?? "").includes("NXDOMAIN"),
        );
        if (stuck.length === 0) return;

        for (const ch of stuck) {
          const ns = ch.metadata?.namespace;
          const dnsName = ch.spec?.dnsName;
          const orderOwner = ch.metadata?.ownerReferences?.find(
            (o) => o.kind === "Order",
          )?.name;
          if (!ns || !dnsName) continue;

          // Probe current DNS.
          const addresses = await resolve4(dnsName).catch(() => [] as string[]);
          const pointsAtUs = addresses.some((ip) =>
            VetraCloudObservabilitySubgraph.CLUSTER_LB_IPS.has(ip),
          );
          if (!pointsAtUs) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: DNS does not resolve to cluster LB (got ${addresses.join(",") || "none"}), skipping`,
            );
            continue;
          }

          // Walk Order → Certificate owner references (Order's owner is the
          // Certificate).
          if (!orderOwner) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: challenge has no Order owner, skipping`,
            );
            continue;
          }
          const order = (await customApi
            .getNamespacedCustomObject({
              group: "acme.cert-manager.io",
              version: "v1",
              plural: "orders",
              namespace: ns,
              name: orderOwner,
            })
            .catch(() => null)) as {
            metadata?: {
              ownerReferences?: Array<{ kind?: string; name?: string }>;
            };
          } | null;
          const certName = order?.metadata?.ownerReferences?.find(
            (o) => o.kind === "Certificate",
          )?.name;
          if (!certName) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: Order has no Certificate owner, skipping`,
            );
            continue;
          }

          // Cooldown check — don't hammer the same Certificate.
          const cert = (await customApi
            .getNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
            })
            .catch(() => null)) as {
            metadata?: { annotations?: Record<string, string> };
          } | null;
          const lastRetry =
            cert?.metadata?.annotations?.[
              VetraCloudObservabilitySubgraph.LAST_RETRY_ANNOTATION
            ];
          if (lastRetry) {
            const elapsed = Date.now() - new Date(lastRetry).getTime();
            if (
              elapsed <
              VetraCloudObservabilitySubgraph.LAST_RETRY_COOLDOWN_MS
            ) {
              console.info(
                `[challenge-reconciler] ${ns}/${certName}: last retry was ${Math.round(elapsed / 1000)}s ago, within cooldown`,
              );
              continue;
            }
          }

          // Stamp the annotation, then delete. Stamping first ensures the
          // recreated Certificate (via Ingress-shim) inherits it and the
          // next run respects the cooldown.
          console.info(
            `[challenge-reconciler] ${ns}/${certName}: DNS now resolves (${addresses.join(",")}) for ${dnsName}, deleting Certificate to retry`,
          );
          try {
            await customApi.patchNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
              body: {
                metadata: {
                  annotations: {
                    [VetraCloudObservabilitySubgraph.LAST_RETRY_ANNOTATION]:
                      new Date().toISOString(),
                  },
                },
              },
            });
          } catch (err) {
            console.warn(
              `[challenge-reconciler] ${ns}/${certName}: annotation patch failed: ${String(err)}`,
            );
            // fall through — deletion is still worth attempting
          }
          try {
            await customApi.deleteNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
            });
          } catch (err) {
            console.warn(
              `[challenge-reconciler] ${ns}/${certName}: delete failed: ${String(err)}`,
            );
          }
        }
      } catch (err) {
        console.warn("[challenge-reconciler] error:", err);
      }
    };

    // Every 2 minutes + once on startup.
    this.challengeReconciler = setInterval(
      () => void reconcile(),
      2 * 60 * 1000,
    );
    void reconcile();
  }

  /**
   * Periodically populate `release_index` from npm dist-tags on
   * `@powerhousedao/connect` and `@powerhousedao/switchboard`. The
   * monorepo publishes every release to npm with dist-tags `dev`,
   * `staging`, and `latest`, each pointing at the current channel head.
   *
   * Without this, `release_index` only has rows for channels whose
   * webhook has fired since the subgraph started — so a new staging
   * env subscriber sees "no release seen" in the UI even though a tag
   * exists on npm. With this, the UI's "latest on channel" and the
   * updateEnvironmentToLatest mutation work immediately, and the
   * notifyNewImageRelease webhook still keeps things fresh on new
   * releases (first writer wins, later writers no-op).
   */
  private static RELEASE_INDEX_PACKAGES: Array<{
    image: string;
    npmPackage: string;
  }> = [
    { image: "CONNECT", npmPackage: "@powerhousedao/connect" },
    { image: "SWITCHBOARD", npmPackage: "@powerhousedao/switchboard" },
  ];
  private static RELEASE_INDEX_CHANNELS: Record<string, string> = {
    DEV: "dev",
    STAGING: "staging",
    LATEST: "latest",
  };

  private startReleaseIndexBackfill(db: Kysely<ObservabilityDB>) {
    const refresh = async () => {
      for (const {
        image,
        npmPackage,
      } of VetraCloudObservabilitySubgraph.RELEASE_INDEX_PACKAGES) {
        let metadata: unknown;
        try {
          const res = await fetch(`https://registry.npmjs.org/${npmPackage}`);
          if (!res.ok) {
            console.warn(
              `[release-index-backfill] ${npmPackage}: HTTP ${res.status}`,
            );
            continue;
          }
          metadata = await res.json();
        } catch (err) {
          console.warn(
            `[release-index-backfill] ${npmPackage}: fetch failed: ${String(err)}`,
          );
          continue;
        }

        const distTags =
          (metadata as { "dist-tags"?: Record<string, string> })[
            "dist-tags"
          ] ?? {};

        for (const [channel, distTag] of Object.entries(
          VetraCloudObservabilitySubgraph.RELEASE_INDEX_CHANNELS,
        )) {
          const version = distTags[distTag];
          if (!version) continue;
          const vTag = version.startsWith("v") ? version : `v${version}`;
          const id = `${channel}/${image}`;

          // Skip if the row is already pointed at this tag — avoids
          // moving publishedAt every 5min for a stable release.
          const existing = await db
            .selectFrom("release_index")
            .select(["tag"])
            .where("id", "=", id)
            .executeTakeFirst();
          if (existing && existing.tag === vTag) continue;

          await db
            .insertInto("release_index")
            .values({
              id,
              channel,
              image,
              tag: vTag,
              publishedAt: new Date().toISOString(),
              releaseUrl: `https://github.com/powerhouse-inc/powerhouse/releases/tag/${vTag}`,
            })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                tag: vTag,
                publishedAt: new Date().toISOString(),
                releaseUrl: `https://github.com/powerhouse-inc/powerhouse/releases/tag/${vTag}`,
              }),
            )
            .execute();
          console.info(
            `[release-index-backfill] ${id}: ${existing?.tag ?? "(new)"} → ${vTag}`,
          );
        }
      }
    };

    // Every 5 minutes + once on startup.
    this.releaseIndexBackfill = setInterval(
      () => void refresh(),
      5 * 60 * 1000,
    );
    void refresh();
  }

}

