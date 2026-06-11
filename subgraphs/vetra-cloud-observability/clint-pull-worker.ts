import type { Kysely } from "kysely";
import type { ILogger } from "document-model";
import { withTracingSuppressed } from "./trace-suppress.js";

export type ClintServiceTuple = {
  documentId: string;
  prefix: string;
  subdomain: string;
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
   * Defaults to `https://${prefix}.${subdomain}.vetra.io/_proxy/routes`.
   * Overridable for tests.
   */
  buildAgentUrl?: (service: ClintServiceTuple) => string;
  /** Per-fetch timeout. Defaults to 5000ms. */
  fetchTimeoutMs?: number;
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DOMAIN = "vetra.io";

function defaultBuildAgentUrl(svc: ClintServiceTuple): string {
  return `https://${svc.prefix}.${svc.subdomain}.${DEFAULT_BASE_DOMAIN}/_proxy/routes`;
}

type ParsedService = {
  type?: string;
  enabled?: boolean;
  prefix?: string;
};

function parseClintServices(servicesJson: string | null): ParsedService[] {
  if (!servicesJson) return [];
  try {
    const parsed = JSON.parse(servicesJson);
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

export class ClintPullWorker {
  private readonly config: ClintPullWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private readonly buildAgentUrl: (svc: ClintServiceTuple) => string;
  private readonly fetchTimeoutMs: number;

  constructor(config: ClintPullWorkerConfig) {
    this.config = config;
    this.buildAgentUrl = config.buildAgentUrl ?? defaultBuildAgentUrl;
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
      await Promise.all(tuples.map((t) => this.pullOne(t)));
    });
  }

  private async listClintServices(): Promise<ClintServiceTuple[]> {
    const rows = await this.config.envDb
      .selectFrom("environments")
      .select(["id", "subdomain", "services"])
      .execute();
    const out: ClintServiceTuple[] = [];
    for (const row of rows) {
      if (!row.subdomain) continue;
      for (const svc of parseClintServices(row.services)) {
        if (svc.type === "CLINT" && svc.enabled === true && svc.prefix) {
          out.push({ documentId: row.id, prefix: svc.prefix, subdomain: row.subdomain });
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
      const res = await fetch(url, { signal: ac.signal });
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
    const existing = await this.config.obsDb
      .selectFrom("clint_runtime_endpoints")
      .select(["id", "endpointId"])
      .where("documentId", "=", svc.documentId)
      .where("prefix", "=", svc.prefix)
      .execute();
    const toDelete = existing
      .filter((r: any) => !presented.has(r.endpointId))
      .map((r: any) => r.id);
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
        .onConflict((oc: any) =>
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
