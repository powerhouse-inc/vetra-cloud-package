/**
 * Renown organisations, as Vetra needs them (spec §6, A1 appendix "Vetra (C)").
 * Public reads only: orgMembership and organization(id) on renown-orgs,
 * appProfile on renown-stats. Every failure throws RenownOrgsUnavailableError
 * and is never cached, so callers can fail closed (org-access.ts) or leave
 * state untouched (sync jobs).
 */
export type OrgRole = "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER";
export interface OrgScope {
  all: boolean;
  appDids: string[];
}
export interface OrgMembership {
  role: OrgRole;
  effectiveScope: OrgScope;
}
/** An app's Renown publisher: an organisation, or a person's address. */
export interface AppPublisher {
  orgId: string | null;
  address: string | null;
}

export class RenownOrgsUnavailableError extends Error {
  override name = "RenownOrgsUnavailableError";
}

export interface RenownOrgs {
  /** The ACTIVE membership of `address`, or null (none, archived or taken-down org). */
  membership(orgId: string, address: string): Promise<OrgMembership | null>;
  /** App DIDs attached to the org; null for an unknown, archived or taken-down org. */
  orgApps(orgId: string): Promise<string[] | null>;
  /** The app's publisher per its Renown profile; null when it has no profile. */
  appPublisher(appDid: string): Promise<AppPublisher | null>;
  /** App DIDs whose Renown profile names this person as publisher (never org-owned apps). */
  personApps(address: string): Promise<string[]>;
}

export interface RenownOrgsConfig {
  orgsEndpoint: string;
  statsEndpoint: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  logger?: Pick<Console, "warn">;
}

/** A small LRU whose entries expire. `get` refreshes recency. */
export class TtlLru<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly max: number) {}

  get(key: string, now: number): { value: V } | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.map.set(key, entry);
    return { value: entry.value };
  }

  set(key: string, value: V, ttlMs: number, now: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const MEMBERSHIP = `query VetraOrgMembership($orgId: String!, $address: String!) {
  orgMembership(orgId: $orgId, address: $address) { role status effectiveScope { all appDids } }
}`;
const ORG_APPS = `query VetraOrgApps($id: String!) {
  organization(id: $id) { id archived takenDown apps { appDid } }
}`;
const APP_PUBLISHER = `query VetraAppPublisher($appDid: String!) {
  appProfile(appDid: $appDid) { publisherDid publisherOrg { id } }
}`;

const PERSON_APPS = `query VetraPersonApps($publisherDid: String!) {
  appProfilesByPublisher(publisherDid: $publisherDid) { appDid }
}`;

/** At most this many app DIDs are taken from one person's profile list. */
export const MAX_PERSON_APPS = 100;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

const PKH = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/;

type Env = Record<string, string | undefined>;

export function renownOrgsConfigFromEnv(env: Env = process.env): RenownOrgsConfig {
  const origin = (env.RENOWN_SWITCHBOARD_URL?.trim() || "https://switchboard.renown.vetra.io")
    .replace(/\/+$/, "")
    .replace(/\/graphql$/, "");
  return {
    orgsEndpoint: env.RENOWN_ORGS_ENDPOINT?.trim() || `${origin}/graphql/renown-orgs`,
    statsEndpoint: env.RENOWN_STATS_URL?.trim() || `${origin}/graphql/renown-stats`,
  };
}

export function createRenownOrgs(cfg: RenownOrgsConfig): RenownOrgs {
  const fetchImpl = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const positiveTtl = cfg.positiveTtlMs ?? 30_000;
  const negativeTtl = cfg.negativeTtlMs ?? 10_000;
  const logger = cfg.logger ?? console;
  const cache = new TtlLru<unknown>(cfg.maxEntries ?? 2_000);
  const inflight = new Map<string, Promise<unknown>>();

  async function post<T>(endpoint: string, query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RenownOrgsUnavailableError(`network: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: T | null;
      errors?: { message?: string }[];
    } | null;
    if (!res.ok || !body || body.errors?.length || !body.data) {
      const message = body?.errors?.[0]?.message;
      throw new RenownOrgsUnavailableError(`HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return body.data;
  }

  function cached<V>(key: string, load: () => Promise<V>): Promise<V> {
    const hit = cache.get(key, now());
    if (hit) return Promise.resolve(hit.value as V);
    const pending = inflight.get(key);
    if (pending) return pending as Promise<V>;
    const request = load()
      .then((value) => {
        const frozen = deepFreeze(value);
        cache.set(key, frozen, frozen === null ? negativeTtl : positiveTtl, now());
        return frozen;
      })
      .catch((err: unknown) => {
        logger.warn(`[renown-orgs] ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }

  return {
    membership(orgId, address) {
      const addr = address.toLowerCase();
      return cached(`m|${orgId}|${addr}`, async () => {
        const data = await post<{
          orgMembership: { role: OrgRole; status: string; effectiveScope: OrgScope } | null;
        }>(cfg.orgsEndpoint, MEMBERSHIP, { orgId, address: addr });
        const m = data.orgMembership;
        return m && m.status === "ACTIVE"
          ? { role: m.role, effectiveScope: { all: m.effectiveScope.all, appDids: m.effectiveScope.appDids } }
          : null;
      });
    },
    orgApps(orgId) {
      return cached(`a|${orgId}`, async () => {
        const data = await post<{
          organization: { archived: boolean; takenDown: boolean; apps: { appDid: string }[] } | null;
        }>(cfg.orgsEndpoint, ORG_APPS, { id: orgId });
        const org = data.organization;
        return org && !org.archived && !org.takenDown ? org.apps.map((a) => a.appDid) : null;
      });
    },
    appPublisher(appDid) {
      return cached(`p|${appDid}`, async () => {
        const data = await post<{
          appProfile: { publisherDid: string | null; publisherOrg: { id: string } | null } | null;
        }>(cfg.statsEndpoint, APP_PUBLISHER, { appDid });
        const profile = data.appProfile;
        if (!profile) return null;
        if (profile.publisherOrg) return { orgId: profile.publisherOrg.id, address: null };
        const pkh = PKH.exec(profile.publisherDid ?? "");
        return { orgId: null, address: pkh ? pkh[1].toLowerCase() : null };
      });
    },
    personApps(address) {
      const addr = address.toLowerCase();
      return cached(`pa|${addr}`, async () => {
        const data = await post<{ appProfilesByPublisher: { appDid: string }[] | null }>(
          cfg.statsEndpoint,
          PERSON_APPS,
          { publisherDid: `did:pkh:eip155:1:${addr}` },
        );
        return (data.appProfilesByPublisher ?? []).slice(0, MAX_PERSON_APPS).map((p) => p.appDid);
      });
    },
  };
}

/**
 * Renown as background reconciliation (ownership sync, adoption) uses it:
 * every lookup is cut off after `timeoutMs` (well under a request budget, so
 * a slow Renown never holds a personal App's read), and after a failure or a
 * timeout every lookup fails at once for `cooldownMs` without a network call.
 * The underlying request keeps running and fills the cache. Request-time
 * access checks do not use this.
 */
export class RenownSyncGuard {
  private openUntil = 0;
  readonly timeoutMs: number;
  readonly cooldownMs: number;

  constructor(opts: { timeoutMs?: number; cooldownMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 1_500;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  async run<T>(load: () => Promise<T>, now: number, timeoutMs = this.timeoutMs): Promise<T> {
    if (now < this.openUntil) {
      throw new RenownOrgsUnavailableError("Renown was unavailable moments ago; lookup skipped");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RenownOrgsUnavailableError(`no answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([load(), timeout]);
    } catch (err) {
      this.openUntil = now + this.cooldownMs;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

let shared: RenownOrgs | null = null;

/** One client (and cache) per process, shared by every subgraph. */
export function defaultRenownOrgs(): RenownOrgs {
  shared ??= createRenownOrgs(renownOrgsConfigFromEnv());
  return shared;
}
