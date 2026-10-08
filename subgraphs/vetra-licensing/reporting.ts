import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { AppReads } from "./app-reads.js";
import { UnauthenticatedError } from "./auth.js";
import type { VetraLicensingDB } from "./db/schema.js";
import { normaliseUserDid } from "./did.js";
import type { ChainEnvRows } from "./environments.js";
import type { GrantStore } from "./grants.js";
import type { LifecycleStore } from "./lifecycle.js";
import { InvalidPublisherInputError } from "./publisher-errors.js";
import type { RenownStatsClient } from "./renown-stats.js";

/**
 * Per-environment reporting tokens and the user-stat relay
 * (contract § vetraLicensing machine `reportUserStat`, § Renown relay).
 *
 * An environment authenticates with a token of its own, written into its
 * secrets at provisioning. It travels in `x-vetra-reporting-token`, never
 * `Authorization` (reactor-api verifies every Authorization bearer as a Renown
 * JWT). The federated gateway forwards only `authorization`, so environments
 * call the subgraph endpoint directly: VETRA_LICENSING_URL, written next to
 * the token.
 */
export const REPORTING_HEADER = "x-vetra-reporting-token";
export const REPORTING_TOKEN_SECRET = "VETRA_REPORTING_TOKEN";
export const LICENSING_URL_ENV = "VETRA_LICENSING_URL";

/** renown-stats' own metric rule (renown-user-stats isMetricName). */
const METRIC = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** Only this hash is stored; the plaintext lives in the environment's secrets. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const newReportingToken = (): string => randomBytes(32).toString("hex");

export interface ReportingDeps {
  db: Kysely<VetraLicensingDB>;
  /** Null when OpenBao is not configured: no tokens are issued. */
  secrets: Pick<SecretsService, "setSecrets"> | null;
  /** The environment's tenant id; null until it has a subdomain. */
  tenantIdOf(environmentId: string): Promise<string | null>;
  /** The environment document's status; decides whether a secret write restarts it. */
  envStatus(environmentId: string): Promise<string | null>;
  /** VETRA_LICENSING_URL. Null: no tokens are issued (an environment could not use one). */
  licensingUrl: string | null;
  newToken(): string;
  now(): string;
  logger: Pick<Console, "info" | "warn">;
}

/**
 * Environments with no running pods that can still start: a secret written
 * now reaches them with their next start instead of restarting them (the
 * secrets controller only reconciles tenants with a live namespace).
 */
const ASLEEP = new Set(["STOPPED", "DRAFT"]);
/** Environments that will never run again: they get no token at all. */
const GONE = new Set(["DESTROYED", "ARCHIVED"]);

/** What one handler tick may still spend, shared by every app of the tick. */
export interface TokenBudget {
  /** Issues to running environments still allowed this tick. */
  remaining: number;
  /** Running environments that wait for a later tick. */
  pending: number;
}

/** Environments whose token issue is running (a timed-out handler step may still be). */
const issuing = new WeakMap<object, Set<string>>();
/**
 * Tokens already written into an environment's secret whose hash row is not
 * yet recorded: the retry records this token instead of minting (and writing,
 * and restarting the environment for) a new one. In memory only; a restart in
 * between costs one more secret write.
 */
const written = new WeakMap<object, Map<string, string>>();
const offLogged = new WeakMap<object, string>();

function stateOf<T>(map: WeakMap<object, T>, deps: object, init: () => T): T {
  let v = map.get(deps);
  if (v === undefined) map.set(deps, (v = init()));
  return v;
}

/** Drops what the issuer remembers of an environment (a token written but not yet recorded). */
export function forgetReportingToken(deps: ReportingDeps, environmentId: string): void {
  written.get(deps)?.delete(environmentId);
}

/**
 * Gives every listed environment a reporting token, once. The secret is
 * written first and the hash second; the written token is remembered until
 * its hash is recorded, so a failing hash write never writes the secret again.
 * A row always means its token reached the secret. Asleep environments go
 * first and cost nothing; destroyed and archived ones get none; every other issue spends one unit of `budget`
 * (unlimited when absent), and those over it are counted as pending.
 * Failures are per environment and logged (never with the token).
 */
export async function ensureReportingTokens(
  deps: ReportingDeps,
  environmentIds: string[],
  budget?: TokenBudget,
): Promise<void> {
  if (environmentIds.length === 0) return;
  const off = !deps.secrets
    ? "the secrets service (OPENBAO_ADDR) is not configured"
    : !deps.licensingUrl
      ? "VETRA_LICENSING_URL is unset"
      : null;
  if (off || !deps.secrets || !deps.licensingUrl) {
    if (off && offLogged.get(deps) !== off) {
      offLogged.set(deps, off);
      deps.logger.info(`[licensing] reporting tokens are not issued: ${off}`);
    }
    return;
  }
  const secrets = deps.secrets;
  const licensingUrl = deps.licensingUrl;
  const running = stateOf(issuing, deps, () => new Set<string>());
  const unrecorded = stateOf(written, deps, () => new Map<string, string>());
  const have = new Set(
    (
      await deps.db
        .selectFrom("environment_reporting_tokens")
        .select("environment_id")
        .where("environment_id", "in", environmentIds)
        .execute()
    ).map((r) => r.environment_id),
  );
  const candidates = environmentIds.filter((id) => !have.has(id) && !running.has(id));
  const todo: string[] = [];
  const free = new Set<string>();
  for (const id of candidates) {
    if (unrecorded.has(id)) {
      todo.push(id);
      free.add(id);
      continue;
    }
    const status = await deps.envStatus(id).catch(() => null);
    if (status !== null && GONE.has(status)) continue;
    todo.push(id);
    if (status !== null && ASLEEP.has(status)) free.add(id);
  }
  const ordered = [...todo.filter((id) => free.has(id)), ...todo.filter((id) => !free.has(id))];

  for (const id of ordered) {
    running.add(id);
    try {
      let token = unrecorded.get(id);
      if (token === undefined) {
        const tenantId = await deps.tenantIdOf(id);
        if (!tenantId) continue;
        if (!free.has(id) && budget) {
          if (budget.remaining <= 0) {
            budget.pending++;
            continue;
          }
          budget.remaining--;
        }
        token = deps.newToken();
        await secrets.setSecrets(tenantId, [
          { key: REPORTING_TOKEN_SECRET, value: token },
          { key: LICENSING_URL_ENV, value: licensingUrl },
        ]);
        unrecorded.set(id, token);
      }
      const token_hash = hashToken(token);
      await deps.db
        .insertInto("environment_reporting_tokens")
        .values({ environment_id: id, token_hash, created_at: deps.now() })
        .onConflict((oc) => oc.column("environment_id").doUpdateSet({ token_hash }))
        .execute();
      unrecorded.delete(id);
    } catch (err) {
      deps.logger.warn(
        `[licensing] reporting token for environment ${id} not issued: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      running.delete(id);
    }
  }
}

/**
 * One budget per handler tick across every app (LICENSING_TOKENS_PER_TICK):
 * startTick() before the first app, issue() from each app's afterApp,
 * endTick() after the last. The pending count is logged once per change.
 */
export function createReportingTokenIssuer(deps: ReportingDeps, perTick: number) {
  let budget: TokenBudget = { remaining: perTick, pending: 0 };
  let lastPending = 0;
  return {
    startTick(): void {
      budget = { remaining: perTick, pending: 0 };
    },
    issue(environmentIds: string[]): Promise<void> {
      return ensureReportingTokens(deps, environmentIds, budget);
    },
    /** Offboarding destroyed the environment: forget its unrecorded token. */
    forget(environmentId: string): void {
      forgetReportingToken(deps, environmentId);
    },
    endTick(): void {
      if (budget.pending === lastPending) return;
      lastPending = budget.pending;
      deps.logger.info(
        budget.pending > 0
          ? `[licensing] ${budget.pending} reporting token(s) pending for running environments (at most ${perTick} per tick; each restarts its environment once)`
          : "[licensing] all reporting tokens issued",
      );
    },
  };
}

/** Offboarding's destroy: the environment's token goes with it. */
export async function deleteReportingToken(db: Kysely<VetraLicensingDB>, environmentId: string): Promise<void> {
  await db.deleteFrom("environment_reporting_tokens").where("environment_id", "=", environmentId).execute();
}

export async function environmentForToken(db: Kysely<VetraLicensingDB>, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await db
    .selectFrom("environment_reporting_tokens")
    .select("environment_id")
    .where("token_hash", "=", hashToken(token))
    .executeTakeFirst();
  return row?.environment_id ?? null;
}

export interface RelayDeps {
  db: Kysely<VetraLicensingDB>;
  envRows: Pick<ChainEnvRows, "byEnvironment">;
  grants: Pick<GrantStore, "chainHead" | "grantFor">;
  lifecycle: Pick<LifecycleStore, "get">;
  /** Ledger-checked app reads: only `tampered` is used, never the document's identity. */
  apps: Pick<AppReads, "app">;
  /** The apps row (vetra-apps): the App's Renown workload identity and status. */
  appIdentity(appId: string): Promise<{ identityDid: string | null; status: string } | null>;
  stats: RenownStatsClient;
  logger: Pick<Console, "info" | "warn">;
}

/** Statuses of an apps row whose identity may report. */
const REPORTING_APP_STATUSES = new Set(["ACTIVE", "DISCONNECTED"]);

/** The last refusal logged per environment: each change is logged once. */
const lastRefusal = new WeakMap<object, Map<string, string>>();

function refuse(deps: RelayDeps, environmentId: string, reason: string): false {
  let seen = lastRefusal.get(deps);
  if (!seen) lastRefusal.set(deps, (seen = new Map<string, string>()));
  if (seen.get(environmentId) !== reason) {
    seen.set(environmentId, reason);
    deps.logger.info(`[licensing] user stat from environment ${environmentId} not relayed: ${reason}`);
  }
  return false;
}

/**
 * token -> environment -> its chain (license_environments) -> the chain's
 * head, recorded ACTIVE, granted for the same app and holder -> the app's
 * recorded workload identity -> Renown. Only the holder's own stats are
 * relayed. Documents are never evidence: holder, app and status come from
 * DB rows, the app DID from the apps row. A refusal is `false` (logged once
 * per change), with no detail for the caller. `true` means queued: delivery
 * is asynchronous and coalesced.
 */
export async function relayUserStat(
  deps: RelayDeps,
  token: string | null,
  input: { user: string; metric: string; value: number },
): Promise<boolean> {
  if (!token) throw new UnauthenticatedError("a reporting token is required");
  const environmentId = await environmentForToken(deps.db, token);
  if (!environmentId) throw new UnauthenticatedError("unknown reporting token");
  if (!METRIC.test(input.metric)) {
    throw new InvalidPublisherInputError("metric must match ^[A-Za-z][A-Za-z0-9_.:-]{0,63}$");
  }
  if (!Number.isFinite(input.value)) throw new InvalidPublisherInputError("value must be a finite number");
  const userDid = normaliseUserDid(input.user);

  const row = await deps.envRows.byEnvironment(environmentId);
  if (!row) return refuse(deps, environmentId, "it has no licence chain");
  if (row.user_did !== userDid) return refuse(deps, environmentId, "the user is not the environment's holder");
  const head = await deps.grants.chainHead(row.root_license_id);
  const grant = await deps.grants.grantFor(head);
  if (!grant || grant.appId !== row.app_id || grant.userDid !== row.user_did) {
    return refuse(deps, environmentId, `its chain head ${head} is not granted to the environment's app and holder`);
  }
  const status = (await deps.lifecycle.get(head))?.status ?? "unrecorded";
  if (status !== "ACTIVE") return refuse(deps, environmentId, `its chain head ${head} is ${status}`);
  const app = await deps.apps.app(row.app_id);
  if (!app) return refuse(deps, environmentId, `app ${row.app_id} has no readable document`);
  if (app.tampered) return refuse(deps, environmentId, `app ${row.app_id} is tampered`);
  const identity = await deps.appIdentity(row.app_id);
  if (!identity?.identityDid || !REPORTING_APP_STATUSES.has(identity.status)) {
    return refuse(deps, environmentId, `app ${row.app_id} has no usable Renown identity`);
  }
  lastRefusal.get(deps)?.delete(environmentId);
  return deps.stats.enqueue({ appDid: identity.identityDid, userDid, metric: input.metric, value: input.value });
}
