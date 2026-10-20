import type { Kysely, OnConflictBuilder } from "kysely";
import type { ILogger } from "document-model";
import { withTracingSuppressed } from "./trace-suppress.js";
import { OBSERVABILITY_PULL_USER_AGENT } from "../vetra-housekeeping/policy.js";
import { isApexCapable } from "../../shared/apex.js";
import { removeEnvironmentRecord } from "../../processors/vetra-cloud-environment/cleanup.js";
import type { DB as EnvironmentsDB } from "../../processors/vetra-cloud-environment/schema.js";

export type ClintServiceTuple = {
  documentId: string;
  prefix: string;
  subdomain: string;
  /** Served at the env apex (`<subdomain>.vetra.io`) — a sole-CLINT Studio. */
  isApex: boolean;
  /** Current per-service status from the read-model (e.g. PROVISIONING/ACTIVE). */
  status?: string | null;
  /** The environment's status from the read-model (e.g. READY/DEPLOYING). */
  envStatus?: string | null;
};

export type ClintPullWorkerConfig = {
  /** Processor's namespace DB — has the `environments` table. */
  envDb: Kysely<any>;
  /** Observability DB — has `clint_runtime_endpoints`. */
  obsDb: Kysely<any>;
  logger: ILogger;
  /** Defaults to 15000ms. */
  intervalMs?: number;
  /**
   * Maps a CLINT service tuple to its `/_proxy/routes` URL.
   * Defaults to the flattened single-label host (apex: `<subdomain>.vetra.io`,
   * else `<subdomain>-<prefix>.vetra.io`) + `/_proxy/routes`.
   * Overridable for tests.
   */
  buildAgentUrl?: (service: ClintServiceTuple) => string;
  /**
   * Maps a studio service to its switchboard GraphQL URL (for the BrandSheet
   * pull). Defaults to `https://<agent-host>/switchboard/graphql`. Overridable
   * for tests (which serve a mock over http).
   */
  buildBrandUrl?: (service: ClintServiceTuple) => string;
  /** Per-fetch timeout. Defaults to 5000ms. */
  fetchTimeoutMs?: number;
  /**
   * Dispatch a document action on an env doc (mirrors the processor's own
   * `reactorClient.execute` helper). Used to advance a CLINT service
   * PROVISIONING → ACTIVE once its website endpoint is live. Optional: when
   * absent (e.g. tests that don't exercise it) the worker only does discovery.
   */
  dispatch?: (
    documentId: string,
    type: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Whether the environment document still exists in the reactor. Asked after
   * {@link FAILURES_BEFORE_BACKOFF} consecutive failed polls: `false` removes
   * the env's read-model row (it outlived its document) so nothing polls it
   * again; `true` or a throw keeps the row and backs off. When absent, failing
   * envs are only backed off.
   */
  documentExists?: (documentId: string, signal?: AbortSignal) => Promise<boolean>;
  /** Timeout of one existence check; a timeout keeps the record. Defaults to 5000ms. */
  existenceCheckTimeoutMs?: number;
  /** Clock for the poll backoff. Defaults to `Date.now`; injected by tests. */
  now?: () => number;
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DOMAIN = "vetra.io";
/** Consecutive failed polls before the existence check and the backoff. */
export const FAILURES_BEFORE_BACKOFF = 3;
/** While failing (after the threshold): at most one poll per this interval. */
export const FAILING_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS = 5_000;
/**
 * Env statuses of a deploy in flight: its agent is expected to fail polls for
 * a while, and the first successful poll is what flips the studio ACTIVE — so
 * these keep the 15 s cadence (no backoff) however many polls fail.
 */
const DEPLOY_PENDING_STATUSES = new Set(["CHANGES_PUSHED", "DEPLOYING"]);
/**
 * The coming-up exemption ends after this many consecutive failures (5 min at
 * 15 s): a studio stuck in PROVISIONING / a deploy that never lands then backs
 * off like any other failing env.
 */
export const COMING_UP_MAX_FAILURES = 20;

/** A service that's still coming up: never backed off. */
function isComingUp(svc: ClintServiceTuple): boolean {
  return (
    svc.status === "PROVISIONING" ||
    DEPLOY_PENDING_STATUSES.has(svc.envStatus ?? "")
  );
}

// Canonical definition lives in the dependency-free housekeeping policy module
// (imported above); re-export for the worker's existing consumers + tests.
export { OBSERVABILITY_PULL_USER_AGENT };

/**
 * Env statuses whose chart renders `global.disabled=true` — no workload/ingress,
 * so there's nothing to poll. STOPPED is housekeeping sleep (wakeable); the rest
 * are teardown. Polling these is wasteful and, for STOPPED, would re-wake the
 * studio via the activator every tick.
 */
const NO_WORKLOAD_STATUSES = new Set([
  "STOPPED",
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

// Mirrors processors/vetra-cloud-environment/gitops.ts resolveGenericHost:
// a single DNS label covered by the *.vetra.io wildcard cert.
function genericHost(subdomain: string, prefix: string, isApex: boolean): string {
  return isApex
    ? `${subdomain}.${DEFAULT_BASE_DOMAIN}`
    : `${subdomain}-${prefix}.${DEFAULT_BASE_DOMAIN}`;
}

function defaultBuildAgentUrl(svc: ClintServiceTuple): string {
  return `https://${genericHost(svc.subdomain, svc.prefix, svc.isApex)}/_proxy/routes`;
}

type ParsedService = {
  type?: string;
  enabled?: boolean;
  prefix?: string;
  status?: string;
};

/** Column shape of the observability `clint_runtime_endpoints` table. */
type ClintRuntimeEndpointRow = {
  id: string;
  documentId: string;
  prefix: string;
  endpointId: string;
  type: string;
  port: string;
  status: string;
  lastSeen: string;
};

/** Column shape of the observability `studio_brand` table. */
type StudioBrandRow = {
  documentId: string;
  subdomain: string | null;
  name: string | null;
  maxim: string | null;
  concept: string | null;
  updatedAt: string;
};

function parseClintServices(servicesJson: string | null): ParsedService[] {
  if (!servicesJson) return [];
  try {
    const parsed: unknown = JSON.parse(servicesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed as ParsedService[];
  } catch {
    return [];
  }
}

/**
 * Shape of one entry returned by ph-clint's `GET /_proxy/routes`.
 * `upstream` is a serialized URL like `http://localhost:35940/graphql`.
 */
type ProxyRoute = {
  prefix: string;
  upstream: string;
  ws?: boolean;
  source?: string;
};

function isProxyRoute(v: unknown): v is ProxyRoute {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.prefix !== "string" || o.prefix.length === 0) return false;
  if (typeof o.upstream !== "string" || o.upstream.length === 0) return false;
  return true;
}

/** Map a route prefix to one of {api-graphql, api-mcp, website}. */
function endpointTypeFromPrefix(prefix: string): string {
  if (prefix.includes("/graphql")) return "api-graphql";
  if (prefix.includes("/mcp")) return "api-mcp";
  return "website";
}

/** Pull `port` out of an upstream URL, falling back to scheme defaults. */
function portFromUpstream(upstream: string): string {
  try {
    const u = new URL(upstream);
    if (u.port) return u.port;
    return u.protocol === "https:" ? "443" : "80";
  } catch {
    return "0";
  }
}

/** BrandSheet product identity fetched from a studio's own switchboard. */
const BRAND_QUERY =
  "query { BrandSheet { documents { items { state { global { name maxim concept } } } } } }";

type ParsedBrand = { name: string; maxim: string | null; concept: string | null };

/**
 * Parse a studio switchboard's BrandSheet response. Returns null for anything
 * that isn't a real, named BrandSheet — an empty `items`, a hibernated studio's
 * `{"status":"waking"}` body, or a malformed shape — so callers never clobber a
 * cached brand with a blank.
 */
function parseBrand(body: unknown): ParsedBrand | null {
  const items = (body as { data?: { BrandSheet?: { documents?: { items?: unknown } } } })?.data
    ?.BrandSheet?.documents?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const g = (items[0] as { state?: { global?: { name?: unknown; maxim?: unknown; concept?: unknown } } })
    ?.state?.global;
  if (!g || typeof g.name !== "string" || g.name.trim() === "") return null;
  return {
    name: g.name,
    maxim: typeof g.maxim === "string" ? g.maxim : null,
    concept: typeof g.concept === "string" ? g.concept : null,
  };
}

function serviceKey(svc: ClintServiceTuple): string {
  return `${svc.documentId}|${svc.prefix}`;
}

export class ClintPullWorker {
  private readonly config: ClintPullWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private readonly buildAgentUrl: (svc: ClintServiceTuple) => string;
  private readonly buildBrandUrl: (svc: ClintServiceTuple) => string;
  private readonly fetchTimeoutMs: number;
  /**
   * Envs (`documentId|prefix`) we've already dispatched SET_SERVICE_STATUS→ACTIVE
   * for this pod lifetime. Attempt-once guard: without it, a mutation that never
   * commits (times out / a pathological doc whose replay overflows the stack)
   * leaves the read-model status at PROVISIONING, so the advance re-fired every
   * tick → reactor job-queue flood → heap OOM → switchboard crashloop. One
   * attempt per env per lifetime bounds it; a genuinely-transient failure retries
   * on the next pod restart (rare, acceptable).
   */
  private readonly statusAdvanceAttempted = new Set<string>();
  /**
   * Consecutive-failure state per polled service (`documentId|prefix`). Absent
   * = healthy (polled every tick). Pruned each tick to the services still
   * listed, so it never outgrows the fleet.
   */
  private readonly failing = new Map<
    string,
    { failures: number; nextPollAt: number }
  >();
  /** When each document's existence was last checked (paces the check). */
  private readonly lastExistenceCheckAt = new Map<string, number>();
  private readonly now: () => number;
  /** A tick is in flight: `start()`'s interval skips instead of overlapping. */
  private ticking = false;

  constructor(config: ClintPullWorkerConfig) {
    this.config = config;
    this.buildAgentUrl = config.buildAgentUrl ?? defaultBuildAgentUrl;
    this.buildBrandUrl =
      config.buildBrandUrl ??
      ((svc) => `https://${new URL(this.buildAgentUrl(svc)).host}/switchboard/graphql`);
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.now = config.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const tick = () => {
      // A slow tick (timeouts across many agents) must not stack up behind the
      // next one: skip while one is still running.
      if (this.ticking) return;
      this.ticking = true;
      this.tickOnce()
        .catch((err) => {
          this.config.logger.warn(
            `[clint-pull-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.ticking = false;
        });
    };
    tick();
    this.timer = setInterval(tick, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tickOnce(): Promise<void> {
    // Suppress tracing for the whole tick — these polling DB queries +
    // agent HTTP fetches would otherwise each become a root transaction
    // (volume scales O(tenant-count)). See trace-suppress.ts.
    await withTracingSuppressed(async () => {
      const tuples = await this.listClintServices();
      const now = this.now();
      const listed = new Set(tuples.map(serviceKey));
      for (const key of this.failing.keys()) {
        if (!listed.has(key)) this.failing.delete(key);
      }
      const listedDocs = new Set(tuples.map((t) => t.documentId));
      for (const id of this.lastExistenceCheckAt.keys()) {
        if (!listedDocs.has(id)) this.lastExistenceCheckAt.delete(id);
      }
      const due = tuples.filter(
        (t) => (this.failing.get(serviceKey(t))?.nextPollAt ?? 0) <= now,
      );
      const results = await Promise.all(
        due.map(async (t) => {
          const [ok] = await Promise.all([
            this.pullOne(t),
            // A Studio's BrandSheet lives on its own (apex) switchboard.
            t.isApex ? this.pullBrand(t) : Promise.resolve(),
          ]);
          return { t, ok };
        }),
      );
      const suspect = new Set<string>();
      for (const { t, ok } of results) {
        const key = serviceKey(t);
        if (ok) {
          this.failing.delete(key);
          continue;
        }
        const failures = (this.failing.get(key)?.failures ?? 0) + 1;
        const overThreshold = failures >= FAILURES_BEFORE_BACKOFF;
        // A studio still coming up keeps the 15 s cadence for its first
        // COMING_UP_MAX_FAILURES failures; everything else backs off.
        const backOff =
          overThreshold &&
          (!isComingUp(t) || failures >= COMING_UP_MAX_FAILURES);
        this.failing.set(key, {
          failures,
          nextPollAt: backOff ? now + FAILING_POLL_INTERVAL_MS : 0,
        });
        // Existence check: at the threshold, then at most once per backoff
        // interval per document (a coming-up studio fails every 15 s).
        const lastCheck = this.lastExistenceCheckAt.get(t.documentId);
        if (
          overThreshold &&
          (lastCheck === undefined || now - lastCheck >= FAILING_POLL_INTERVAL_MS)
        ) {
          suspect.add(t.documentId);
        }
      }
      for (const documentId of suspect) {
        this.lastExistenceCheckAt.set(documentId, now);
        await this.checkFailingEnvironment(documentId);
      }
    });
  }

  /**
   * A service failed {@link FAILURES_BEFORE_BACKOFF}+ polls in a row. If its
   * environment document is gone, the read-model row outlived it (the delete
   * subscription missed it): remove the row so nothing polls it again. The
   * orphan-dir GC then sees the tenant as dead too. A check that throws or
   * times out keeps the row: a reactor hiccup must never delete a live env's
   * record.
   */
  private async checkFailingEnvironment(documentId: string): Promise<void> {
    const documentExists = this.config.documentExists;
    if (!documentExists) return;
    const timeoutMs =
      this.config.existenceCheckTimeoutMs ?? DEFAULT_EXISTENCE_CHECK_TIMEOUT_MS;
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let exists: boolean;
    try {
      exists = await Promise.race([
        documentExists(documentId, ac.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      this.config.logger.warn(
        `[clint-pull-worker] ${documentId} existence check failed, backing off: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    } finally {
      clearTimeout(timer);
    }
    if (exists) return;
    try {
      // envDb is the processor's namespace: the `environments` table it types.
      await removeEnvironmentRecord(
        this.config.envDb as Kysely<EnvironmentsDB>,
        documentId,
      );
      for (const key of this.failing.keys()) {
        if (key.startsWith(`${documentId}|`)) this.failing.delete(key);
      }
      this.lastExistenceCheckAt.delete(documentId);
      this.config.logger.error(
        `[clint-pull-worker] ${documentId} environment document no longer exists: removed its record, stopped polling`,
      );
    } catch (err) {
      this.config.logger.error(
        `[clint-pull-worker] ${documentId} failed to remove the record of a deleted environment: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Fetch the studio's BrandSheet and cache name/maxim/concept in `studio_brand`
   * so /user/products shows the real product name even after the studio sleeps.
   * No-clobber: an empty/waking/failed response leaves the last cached row.
   */
  private async pullBrand(svc: ClintServiceTuple): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    try {
      const res = await fetch(this.buildBrandUrl(svc), {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": OBSERVABILITY_PULL_USER_AGENT,
        },
        body: JSON.stringify({ query: BRAND_QUERY }),
      });
      if (!res.ok) return; // keep last cached
      const brand = parseBrand((await res.json()) as unknown);
      if (!brand) return; // empty / waking / malformed → keep last cached
      const now = new Date().toISOString();
      await this.config.obsDb
        .insertInto("studio_brand")
        .values({
          documentId: svc.documentId,
          subdomain: svc.subdomain,
          name: brand.name,
          maxim: brand.maxim,
          concept: brand.concept,
          updatedAt: now,
        })
        .onConflict((oc: OnConflictBuilder<{ studio_brand: StudioBrandRow }, "studio_brand">) =>
          oc.column("documentId").doUpdateSet({
            subdomain: svc.subdomain,
            name: brand.name,
            maxim: brand.maxim,
            concept: brand.concept,
            updatedAt: now,
          }),
        )
        .execute();
    } catch {
      // keep last cached
    } finally {
      clearTimeout(t);
    }
  }

  private async listClintServices(): Promise<ClintServiceTuple[]> {
    const rows: {
      id: string;
      subdomain: string | null;
      services: string | null;
      status: string | null;
    }[] = await this.config.envDb
      .selectFrom("environments")
      .select(["id", "subdomain", "services", "status"])
      .execute();
    const out: ClintServiceTuple[] = [];
    for (const row of rows) {
      if (!row.subdomain) continue;
      // Skip envs with no running workload — STOPPED (housekeeping sleep) and the
      // terminal statuses render global.disabled=true, so there's nothing to poll.
      // Polling a STOPPED studio would also hit the wake activator every tick and
      // re-wake it, defeating the sleep. See the studio-housekeeping design.
      if (NO_WORKLOAD_STATUSES.has(row.status ?? "")) continue;
      const all = parseClintServices(row.services);
      // Apex = sole enabled ROUTABLE service (mirrors gitops effectiveApexType's
      // single-service default) → a Studio's lone CLINT agent is at the apex.
      // The isApexCapable filter is shared with gitops on purpose: it excludes
      // ingress-less types like DOCLING, which otherwise inflate the count and
      // send us polling `<subdomain>-<prefix>.vetra.io` for an agent that gitops
      // actually published at the bare `<subdomain>.vetra.io`.
      const enabledCount = all.filter(
        (s) => s.enabled === true && isApexCapable(s.type),
      ).length;
      for (const svc of all) {
        if (svc.type === "CLINT" && svc.enabled === true && svc.prefix) {
          out.push({
            documentId: row.id,
            prefix: svc.prefix,
            subdomain: row.subdomain,
            isApex: enabledCount === 1,
            status: svc.status ?? null,
            envStatus: row.status,
          });
        }
      }
    }
    return out;
  }

  /** Poll one agent's routes. Resolves `true` when the agent answered 2xx. */
  private async pullOne(svc: ClintServiceTuple): Promise<boolean> {
    const url = this.buildAgentUrl(svc);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    try {
      // Distinct UA so the housekeeping idle signal + wake activator can exclude
      // this poll as automation (not a "proper request"). See studio-housekeeping.
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { "user-agent": OBSERVABILITY_PULL_USER_AGENT },
      });
      if (!res.ok) {
        this.config.logger.warn(
          `[clint-pull-worker] ${svc.documentId} ${svc.prefix} ${res.status} from ${url}`,
        );
        return false;
      }
      const body = (await res.json()) as unknown;
      const raw = Array.isArray(body) ? body : [];
      const routes = raw.filter(isProxyRoute);
      await this.upsert(svc, routes);
      await this.maybeMarkServiceActive(svc, routes);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.config.logger.warn(
        `[clint-pull-worker] ${svc.documentId} ${svc.prefix} fetch failed: ${reason}`,
      );
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Advance a CLINT service PROVISIONING → ACTIVE the first time its live
   * website endpoint is discovered. The env-doc's per-service status is what the
   * post-creation "provisioning" screen polls, and nothing else advances it — so
   * a cold-created (BYOK) studio would otherwise spin on "provisioning" forever
   * even though its agent is serving (warm-claimed studios sidestep this because
   * the claim redirects straight in). Guarded on the current status so it fires
   * exactly once, not on every 15s tick. Never throws: a transient dispatch
   * failure just retries next tick.
   */
  private async maybeMarkServiceActive(
    svc: ClintServiceTuple,
    routes: ProxyRoute[],
  ): Promise<void> {
    if (!this.config.dispatch) return;
    if (svc.status === "ACTIVE") return;
    const hasWebsite = routes.some(
      (r) => endpointTypeFromPrefix(r.prefix) === "website",
    );
    if (!hasWebsite) return;
    // Attempt-once-per-lifetime guard (see statusAdvanceAttempted): the read-model
    // status only clears this via the `=== "ACTIVE"` check above once the mutation
    // COMMITS; if it never commits we must not re-dispatch every tick. Mark before
    // dispatching so a throw/timeout doesn't reopen the storm.
    const key = `${svc.documentId}|${svc.prefix}`;
    if (this.statusAdvanceAttempted.has(key)) return;
    this.statusAdvanceAttempted.add(key);
    try {
      await this.config.dispatch(svc.documentId, "SET_SERVICE_STATUS", {
        type: "CLINT",
        // Target THIS service by prefix. Without it the reducer advances the
        // first CLINT by type, so multi-agent envs never advance their other
        // agents and this dispatch re-fired every tick — the storm that bloated
        // env docs to ~30k ops. Requires vetra-cloud-package >= this version.
        prefix: svc.prefix,
        status: "ACTIVE",
      });
      this.config.logger.info(
        `[clint-pull-worker] ${svc.documentId} ${svc.prefix} CLINT → ACTIVE (website endpoint live)`,
      );
    } catch (err) {
      this.config.logger.warn(
        `[clint-pull-worker] ${svc.documentId} failed to mark CLINT ACTIVE: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async upsert(svc: ClintServiceTuple, routes: ProxyRoute[]): Promise<void> {
    const now = new Date().toISOString();
    // The route's prefix is the path under the proxy (e.g. "/switchboard/graphql").
    // We use it as the endpointId — stable, unique within a (documentId, prefix).
    const presented = new Set(routes.map((r) => r.prefix));

    // Delete entries no longer present.
    const existing: { id: string; endpointId: string }[] = await this.config.obsDb
      .selectFrom("clint_runtime_endpoints")
      .select(["id", "endpointId"])
      .where("documentId", "=", svc.documentId)
      .where("prefix", "=", svc.prefix)
      .execute();
    const toDelete = existing
      .filter((r) => !presented.has(r.endpointId))
      .map((r) => r.id);
    if (toDelete.length > 0) {
      await this.config.obsDb
        .deleteFrom("clint_runtime_endpoints")
        .where("id", "in", toDelete)
        .execute();
    }

    // Upsert the rest. Replace `lastSeen` on every tick.
    for (const route of routes) {
      const endpointId = route.prefix;
      const id = `${svc.documentId}|${svc.prefix}|${endpointId}`;
      const values = {
        id,
        documentId: svc.documentId,
        prefix: svc.prefix,
        endpointId,
        type: endpointTypeFromPrefix(route.prefix),
        port: portFromUpstream(route.upstream),
        status: "enabled",
        lastSeen: now,
      };
      // ON CONFLICT for upsert. SQLite + Postgres both support this.
      await this.config.obsDb
        .insertInto("clint_runtime_endpoints")
        .values(values)
        .onConflict((oc: OnConflictBuilder<{ clint_runtime_endpoints: ClintRuntimeEndpointRow }, "clint_runtime_endpoints">) =>
          oc.column("id").doUpdateSet({
            type: values.type,
            port: values.port,
            status: values.status,
            lastSeen: values.lastSeen,
          }),
        )
        .execute();
    }
  }
}
