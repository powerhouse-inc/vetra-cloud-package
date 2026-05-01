import type { Kysely } from "kysely";
import type { ILogger } from "document-model";

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
   * Maps a CLINT service tuple to its public `/clint/endpoints` URL.
   * Defaults to `https://${prefix}.${subdomain}.vetra.io/clint/endpoints`.
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
  return `https://${svc.prefix}.${svc.subdomain}.${DEFAULT_BASE_DOMAIN}/clint/endpoints`;
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

export class ClintPullWorker {
  #config: ClintPullWorkerConfig;
  #timer: NodeJS.Timeout | null = null;
  readonly #buildAgentUrl: (svc: ClintServiceTuple) => string;
  readonly #fetchTimeoutMs: number;

  constructor(config: ClintPullWorkerConfig) {
    this.#config = config;
    this.#buildAgentUrl = config.buildAgentUrl ?? defaultBuildAgentUrl;
    this.#fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  start(): void {
    if (this.#timer) return;
    const interval = this.#config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const tick = () => {
      this.tickOnce().catch((err) => {
        this.#config.logger.warn(
          `[clint-pull-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    tick();
    this.#timer = setInterval(tick, interval);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tickOnce(): Promise<void> {
    const tuples = await this.#listClintServices();
    await Promise.all(tuples.map((t) => this.#pullOne(t)));
  }

  async #listClintServices(): Promise<ClintServiceTuple[]> {
    const rows = await this.#config.envDb
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

  async #pullOne(svc: ClintServiceTuple): Promise<void> {
    const url = this.#buildAgentUrl(svc);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.#fetchTimeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) {
        this.#config.logger.warn(
          `[clint-pull-worker] ${svc.documentId} ${svc.prefix} ${res.status} from ${url}`,
        );
        return;
      }
      const body = (await res.json()) as { endpoints?: unknown };
      const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
      await this.#upsert(svc, endpoints as Array<Record<string, string>>);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#config.logger.warn(
        `[clint-pull-worker] ${svc.documentId} ${svc.prefix} fetch failed: ${reason}`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  async #upsert(
    svc: ClintServiceTuple,
    endpoints: Array<Record<string, string>>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const presented = new Set(endpoints.map((e) => e.id).filter(Boolean));

    // Delete entries no longer present.
    const existing = await this.#config.obsDb
      .selectFrom("clint_runtime_endpoints")
      .select(["id", "endpointId"])
      .where("documentId", "=", svc.documentId)
      .where("prefix", "=", svc.prefix)
      .execute();
    const toDelete = existing
      .filter((r: any) => !presented.has(r.endpointId))
      .map((r: any) => r.id);
    if (toDelete.length > 0) {
      await this.#config.obsDb
        .deleteFrom("clint_runtime_endpoints")
        .where("id", "in", toDelete)
        .execute();
    }

    // Upsert the rest. Replace `lastSeen` on every tick.
    for (const ep of endpoints) {
      if (!ep.id) continue;
      const id = `${svc.documentId}|${svc.prefix}|${ep.id}`;
      const values = {
        id,
        documentId: svc.documentId,
        prefix: svc.prefix,
        endpointId: ep.id,
        type: ep.type ?? "",
        port: ep.port ?? "",
        status: ep.status ?? "enabled",
        lastSeen: now,
      };
      // Use ON CONFLICT for upsert. SQLite + Postgres both support this.
      await this.#config.obsDb
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
