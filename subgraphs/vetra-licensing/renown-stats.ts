import { REGISTRATION_TOKEN_HEADER } from "../vetra-apps/renown.js";

/**
 * The client side of the Renown stats relay (contract § Renown, relay).
 *
 * Vetra holds no app keys. For each app DID it mints a short-lived stats
 * token with renown-workload's
 *   mutation { issueAppStatsToken(did: String!): AppStatsToken! { accessToken expiresIn } }
 * authorised by the workload registration-token header vetra-apps already
 * sends, and presents it to renown-stats'
 *   mutation { reportUserStat(appDid: String!, userDid: String!, metric: String!, value: Float!): Boolean! }
 * in the X-Renown-App-Token header, never Authorization (the host verifies
 * every Authorization bearer itself and would refuse the stats audience).
 */

/** renown-stats reads app tokens from this header (it lowercases to `x-renown-app-token`). */
export const APP_TOKEN_HEADER = "X-Renown-App-Token";

export interface StatReport {
  appDid: string;
  userDid: string;
  metric: string;
  value: number;
}

export interface RenownStatsClient {
  /** Queues the CURRENT value; false when the relay is off, its queue is full, or Renown recently refused the app. */
  enqueue(report: StatReport): boolean;
  /** Sends everything queued. Never throws; failures are logged. */
  flush(): Promise<void>;
  /** Clears the flush timer. */
  stop(): void;
}

export interface RenownStatsConfig {
  /** RENOWN_STATS_URL, e.g. https://switchboard.renown.vetra.io/graphql/renown-stats. Null: relay off. */
  statsUrl: string | null;
  /** `<RENOWN_SWITCHBOARD_URL>/graphql/renown-workload`. Null: relay off. */
  workloadUrl: string | null;
  /** RENOWN_WORKLOAD_REGISTRATION_TOKEN. Null: relay off. */
  registrationToken: string | null;
  /** 0 disables the timer (tests flush by hand). */
  flushIntervalMs?: number;
}

/** Renown issues 10-minute tokens (APP_STATS_TOKEN_TTL_SEC = 600). */
const DEFAULT_TOKEN_LIFE_MS = 10 * 60_000;
/** A token is replaced this long before Renown says it expires. */
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_FLUSH_MS = 5_000;
/** After an app is refused (FORBIDDEN, unknown DID), its reports are dropped this long. */
const REFUSED_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Distinct (app, user, metric) keys held between flushes. */
const MAX_PENDING = 10_000;

/** Failures worth keeping the report for: the next flush tries again. */
const TRANSIENT = new Set(["NETWORK", "HTTP_5XX", "RATE_LIMITED"]);
/** The token was not accepted: drop it and re-mint once. */
const AUTH = new Set(["HTTP_401", "UNAUTHENTICATED", "FORBIDDEN"]);

class RenownCallError extends Error {
  override name = "RenownCallError";
  /** Which call failed: a refused mint backs off the app, a refused report may not. */
  stage: "mint" | "report" = "report";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ISSUE_TOKEN = `mutation IssueAppStatsToken($did: String!) {
  issueAppStatsToken(did: $did) { accessToken expiresIn }
}`;

const REPORT = `mutation ReportUserStat($appDid: String!, $userDid: String!, $metric: String!, $value: Float!) {
  reportUserStat(appDid: $appDid, userDid: $userDid, metric: $metric, value: $value)
}`;

const keyOf = (r: StatReport) => `${r.appDid}\u0000${r.userDid}\u0000${r.metric}`;

export function createRenownStatsClient(
  cfg: RenownStatsConfig,
  deps: {
    fetch?: typeof fetch;
    now?: () => number;
    logger?: Pick<Console, "info" | "warn">;
  } = {},
): RenownStatsClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;

  const pending = new Map<string, StatReport>();
  const tokens = new Map<string, { token: string; until: number }>();
  /** App DIDs Renown refused, until when. */
  const refused = new Map<string, number>();
  /** The last failure logged per app DID: each change is logged once. */
  const lastFailure = new Map<string, string>();
  let inflight: Promise<void> | null = null;
  let offLogged = false;
  let fullLogged = false;

  const offReason = !cfg.statsUrl
    ? "RENOWN_STATS_URL unset"
    : !cfg.workloadUrl || !cfg.registrationToken
      ? "RENOWN_WORKLOAD_REGISTRATION_TOKEN unset"
      : null;

  async function gql<T>(url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RenownCallError("NETWORK", err instanceof Error ? err.message : "request failed");
    }
    if (res.status === 401) throw new RenownCallError("HTTP_401", "401 Unauthorized");
    if (res.status >= 500) throw new RenownCallError("HTTP_5XX", `HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      data?: T | null;
      errors?: { message?: string; extensions?: { code?: string } }[];
    } | null;
    const err = body?.errors?.[0];
    if (err) throw new RenownCallError(err.extensions?.code ?? "GRAPHQL_ERROR", err.message ?? "error");
    if (!res.ok || !body?.data) throw new RenownCallError(`HTTP_${res.status}`, "no data");
    return body.data;
  }

  async function tokenFor(appDid: string): Promise<string> {
    const cached = tokens.get(appDid);
    if (cached && now() < cached.until) return cached.token;
    try {
      return await mint(appDid);
    } catch (err) {
      if (err instanceof RenownCallError) err.stage = "mint";
      throw err;
    }
  }

  async function mint(appDid: string): Promise<string> {
    const data = await gql<{ issueAppStatsToken: { accessToken?: unknown; expiresIn?: unknown } | null }>(
      cfg.workloadUrl!,
      { [REGISTRATION_TOKEN_HEADER]: cfg.registrationToken! },
      ISSUE_TOKEN,
      { did: appDid },
    );
    const issued = data.issueAppStatsToken;
    if (!issued || typeof issued.accessToken !== "string" || issued.accessToken === "") {
      throw new RenownCallError("MALFORMED_TOKEN", "issueAppStatsToken returned no accessToken");
    }
    const life =
      typeof issued.expiresIn === "number" && issued.expiresIn > 0
        ? issued.expiresIn * 1000
        : DEFAULT_TOKEN_LIFE_MS;
    tokens.set(appDid, { token: issued.accessToken, until: now() + Math.max(0, life - TOKEN_MARGIN_MS) });
    return issued.accessToken;
  }

  async function report(r: StatReport, token: string): Promise<void> {
    await gql(cfg.statsUrl!, { [APP_TOKEN_HEADER]: token }, REPORT, {
      appDid: r.appDid,
      userDid: r.userDid,
      metric: r.metric,
      value: r.value,
    });
  }

  /** Mint (or reuse) and report; a refused token is dropped and re-minted once. */
  async function deliver(r: StatReport): Promise<void> {
    const token = await tokenFor(r.appDid);
    try {
      await report(r, token);
    } catch (err) {
      // Only the report's refusal says the token is bad; a refused mint is final.
      if (!(err instanceof RenownCallError) || !AUTH.has(err.code)) throw err;
      tokens.delete(r.appDid);
      await report(r, await tokenFor(r.appDid));
    }
  }

  /** Current values: a newer report of the same key supersedes a kept one. */
  function keep(r: StatReport): void {
    const key = keyOf(r);
    if (!pending.has(key)) pending.set(key, r);
  }

  function failed(r: StatReport, err: unknown): void {
    const code = err instanceof RenownCallError ? err.code : "ERROR";
    const mintFailed = err instanceof RenownCallError && err.stage === "mint";
    if (TRANSIENT.has(code)) {
      keep(r);
    } else if (mintFailed || AUTH.has(code)) {
      // The app itself is refused (identity pending, delegation lapsed or
      // revoked, unknown DID, no usable token, a report refused even with a
      // fresh token): drop, and stop asking for a while.
      tokens.delete(r.appDid);
      refused.set(r.appDid, now() + REFUSED_BACKOFF_MS);
    }
    // Anything else (BAD_USER_INPUT, an unexpected answer) concerns this
    // report only: it is dropped and the app carries on.
    if (lastFailure.get(r.appDid) === code) return;
    lastFailure.set(r.appDid, code);
    // Messages are Renown's or the fetch's; tokens are never part of them.
    const message = err instanceof Error ? err.message : "unknown error";
    logger.warn(`[licensing] renown stats for app ${r.appDid} not delivered (${code}): ${message}`);
  }

  async function runFlush(): Promise<void> {
    const batch = [...pending.values()];
    pending.clear();
    /** Apps Renown rate-limited in this flush: the rest of their reports wait. */
    const limited = new Set<string>();
    for (const r of batch) {
      const until = refused.get(r.appDid);
      if (until !== undefined && now() < until) continue;
      refused.delete(r.appDid);
      if (limited.has(r.appDid)) {
        keep(r);
        continue;
      }
      try {
        await deliver(r);
        if (lastFailure.delete(r.appDid)) {
          logger.info(`[licensing] renown stats for app ${r.appDid} delivered again`);
        }
      } catch (err) {
        failed(r, err);
        if (err instanceof RenownCallError && err.code === "RATE_LIMITED") limited.add(r.appDid);
      }
    }
  }

  function flush(): Promise<void> {
    if (offReason) return Promise.resolve();
    inflight ??= runFlush().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const interval = cfg.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (!offReason && interval > 0) {
    timer = setInterval(() => void flush(), interval);
    timer.unref();
  }

  return {
    enqueue(r) {
      if (offReason) {
        if (!offLogged) {
          offLogged = true;
          logger.info(`[licensing] user stats are not relayed to Renown: ${offReason}`);
        }
        return false;
      }
      // Renown refused this app recently (FORBIDDEN): tell the caller now.
      const until = refused.get(r.appDid);
      if (until !== undefined && now() < until) return false;
      const key = keyOf(r);
      if (!pending.has(key) && pending.size >= MAX_PENDING) {
        if (!fullLogged) {
          fullLogged = true;
          logger.warn(`[licensing] renown stats queue is full (${MAX_PENDING}); new reports are dropped`);
        }
        return false;
      }
      // Current value, not a delta: the newest report per (app, user, metric) wins.
      pending.set(key, r);
      return true;
    },
    flush,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
