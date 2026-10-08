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
  /** VETRA_LICENSING_URL. Null: no tokens are issued (an environment could not use one). */
  licensingUrl: string | null;
  newToken(): string;
  now(): string;
  logger: Pick<Console, "info" | "warn">;
}

/** Environments whose token issue is running (a timed-out handler step may still be). */
const issuing = new WeakMap<object, Set<string>>();
const offLogged = new WeakMap<object, string>();

/**
 * Gives every listed environment a reporting token, once. The secret is
 * written first and the hash second: if the hash write fails the next call
 * mints a new token and overwrites the secret, so an environment never holds
 * a token whose hash is missing for longer than a tick, and a row always
 * means its token reached the secret. Failures are per environment and
 * logged (never with the token).
 */
export async function ensureReportingTokens(deps: ReportingDeps, environmentIds: string[]): Promise<void> {
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
  let running = issuing.get(deps);
  if (!running) issuing.set(deps, (running = new Set<string>()));
  const have = new Set(
    (
      await deps.db
        .selectFrom("environment_reporting_tokens")
        .select("environment_id")
        .where("environment_id", "in", environmentIds)
        .execute()
    ).map((r) => r.environment_id),
  );
  for (const id of environmentIds) {
    if (have.has(id) || running.has(id)) continue;
    running.add(id);
    try {
      const tenantId = await deps.tenantIdOf(id);
      if (!tenantId) continue;
      const token = deps.newToken();
      await deps.secrets.setSecrets(tenantId, [
        { key: REPORTING_TOKEN_SECRET, value: token },
        { key: LICENSING_URL_ENV, value: deps.licensingUrl },
      ]);
      const token_hash = hashToken(token);
      await deps.db
        .insertInto("environment_reporting_tokens")
        .values({ environment_id: id, token_hash, created_at: deps.now() })
        .onConflict((oc) => oc.column("environment_id").doUpdateSet({ token_hash }))
        .execute();
    } catch (err) {
      deps.logger.warn(
        `[licensing] reporting token for environment ${id} not issued: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      running.delete(id);
    }
  }
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
