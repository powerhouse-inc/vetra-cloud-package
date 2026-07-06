import type { Kysely, OnConflictBuilder } from "kysely";
import type { ILogger } from "document-model";
import { withTracingSuppressed } from "./trace-suppress.js";
import { OBSERVABILITY_PULL_USER_AGENT } from "../vetra-housekeeping/policy.js";

export type ClintServiceTuple = {
  documentId: string;
  prefix: string;
  subdomain: string;
  /** Served at the env apex (`<subdomain>.vetra.io`) — a sole-CLINT Studio. */
  isApex: boolean;
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
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DOMAIN = "vetra.io";

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

export class ClintPullWorker {
  private readonly config: ClintPullWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private readonly buildAgentUrl: (svc: ClintServiceTuple) => string;
  private readonly buildBrandUrl: (svc: ClintServiceTuple) => string;
  private readonly fetchTimeoutMs: number;

  constructor(config: ClintPullWorkerConfig) {
    this.config = config;
    this.buildAgentUrl = config.buildAgentUrl ?? defaultBuildAgentUrl;
    this.buildBrandUrl =
      config.buildBrandUrl ??
      ((svc) => `https://${new URL(this.buildAgentUrl(svc)).host}/switchboard/graphql`);
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const tick = () => {
      this.tickOnce().catch((err) => {
        this.config.logger.warn(
          `[clint-pull-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      await Promise.all(
        tuples.map((t) =>
          Promise.all([
            this.pullOne(t),
            // A Studio's BrandSheet lives on its own (apex) switchboard.
            t.isApex ? this.pullBrand(t) : Promise.resolve(),
          ]),
        ),
      );
    });
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
      // Apex = sole enabled service (mirrors gitops effectiveApexType's
      // single-service default) → a Studio's lone CLINT agent is at the apex.
      const enabledCount = all.filter((s) => s.enabled === true).length;
      for (const svc of all) {
        if (svc.type === "CLINT" && svc.enabled === true && svc.prefix) {
          out.push({
            documentId: row.id,
            prefix: svc.prefix,
            subdomain: row.subdomain,
            isApex: enabledCount === 1,
          });
        }
      }
    }
    return out;
  }

  private async pullOne(svc: ClintServiceTuple): Promise<void> {
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
        return;
      }
      const body = (await res.json()) as unknown;
      const raw = Array.isArray(body) ? body : [];
      const routes = raw.filter(isProxyRoute);
      await this.upsert(svc, routes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.config.logger.warn(
        `[clint-pull-worker] ${svc.documentId} ${svc.prefix} fetch failed: ${reason}`,
      );
    } finally {
      clearTimeout(t);
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
