import { setCustomDomain } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { INGRESS_IP } from "../../../document-models/vetra-cloud-environment/v1/src/reducers/utils.js";
import { auditCaller } from "../audit/service.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { Caller } from "../auth.js";
import type { CustomDomainStatus } from "../db/schema.js";
import { appsError } from "../errors.js";
import {
  loadOwnInstance,
  loadOwnInstanceForHolder,
} from "../holders/access.js";
import { withEnvLock } from "../../../shared/key-lock.js";
import { INSTANCE_BASE_DOMAIN } from "../instances/reconciler.js";
import { isInstanceRole } from "../instances/render.js";
import {
  getInstance,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { randomBytes } from "node:crypto";
import { dnsReady } from "./dns.js";
import { validateDomain } from "./validate.js";

/** How long a domain may wait for its DNS before Vetra gives up. */
export const DNS_WAIT_MS = 7 * 24 * 3600_000;
/** How long a certificate may take once the domain is applied. */
export const ISSUING_WAIT_MS = 60 * 60_000;
/** Active domains get a TLS check this often. */
export const ACTIVE_CHECK_EVERY_MS = 24 * 3600_000;
/** Failed daily checks in a row before an active domain's reason says so. */
export const ACTIVE_FAILURES_REPORTED = 3;

export const DNS_NEVER_POINTED = "DNS never pointed at Vetra";
export const NO_CERTIFICATE_YET =
  "no certificate yet: check that nothing else (a CDN proxy, CAA records) answers for the domain";

export type CustomDomainStatusName = "DNS" | "ISSUING" | "ACTIVE" | "FAILED";

export interface DnsRecordHint {
  type: string;
  host: string;
  value: string;
}

export const VERIFY_PREFIX = "_vetra-verify.";

export interface InstanceCustomDomainJson {
  domain: string;
  status: CustomDomainStatusName;
  reason: string | null;
  since: string | null;
  records: DnsRecordHint[];
  alternative: DnsRecordHint | null;
}

/**
 * Whether the instance's document should carry the domain: once DNS points at
 * Vetra (issuing), when served (active), and when the certificate is late
 * (failed after issuing). Never while waiting for DNS, nor after DNS gave up.
 */
export function appliedDomainOf(
  row: Pick<
    InstanceRow,
    "custom_domain" | "custom_domain_status" | "custom_domain_reason"
  >,
): string | null {
  const status = row.custom_domain_status ?? null;
  if (!row.custom_domain) return null;
  if (status === "issuing" || status === "active") return row.custom_domain;
  if (status === "failed" && row.custom_domain_reason !== DNS_NEVER_POINTED)
    return row.custom_domain;
  return null;
}

/** What the holder puts in their DNS: an A record at the ingress, or a CNAME at the generated host (not at an apex). */
export function customDomainInstructions(
  row: Pick<InstanceRow, "host" | "custom_domain"> & {
    custom_domain_token?: string | null;
    custom_domain_status?: CustomDomainStatus | null;
  },
): { records: DnsRecordHint[]; alternative: DnsRecordHint | null } {
  const domain = row.custom_domain ?? "";
  return {
    records: [
      { type: "A", host: domain, value: INGRESS_IP },
      // Proof of control, asked until the domain leaves `dns`.
      ...(row.custom_domain_token && row.custom_domain_status === "dns"
        ? [
            {
              type: "TXT",
              host: `${VERIFY_PREFIX}${domain}`,
              value: row.custom_domain_token,
            },
          ]
        : []),
    ],
    alternative: row.host
      ? {
          type: "CNAME",
          host: domain,
          value: `${row.host}.${INSTANCE_BASE_DOMAIN}`,
        }
      : null,
  };
}

const waitingForDns = (row: Pick<InstanceRow, "host">) =>
  `point an A record at ${INGRESS_IP}${row.host ? ` (or a CNAME at ${row.host}.${INSTANCE_BASE_DOMAIN})` : ""}`;

export function customDomainJson(
  row: Pick<
    InstanceRow,
    | "host"
    | "custom_domain"
    | "custom_domain_status"
    | "custom_domain_reason"
    | "custom_domain_since"
  > & { custom_domain_token?: string | null },
): InstanceCustomDomainJson | null {
  if (!row.custom_domain || !row.custom_domain_status) return null;
  return {
    domain: row.custom_domain,
    status: row.custom_domain_status.toUpperCase() as CustomDomainStatusName,
    reason: row.custom_domain_reason ?? null,
    since: row.custom_domain_since ?? null,
    ...customDomainInstructions(row),
  };
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === "23505";

const TAKEN = "That domain is already used by another environment or instance";

const CLEARED: InstancePatch = {
  custom_domain: null,
  custom_domain_status: null,
  custom_domain_reason: null,
  custom_domain_since: null,
  custom_domain_checked_at: null,
  custom_domain_failures: null,
  custom_domain_token: null,
};

async function assertFree(
  deps: AppsDeps,
  domain: string,
  row: InstanceRow,
): Promise<void> {
  const other = await deps.db
    .selectFrom("instances")
    .select("id")
    .where("custom_domain", "=", domain)
    // dns/failed claims proved nothing; only a domain being served is taken.
    .where("custom_domain_status", "in", ["issuing", "active"])
    .where("id", "!=", row.id)
    .executeTakeFirst();
  if (other) throw appsError("BAD_USER_INPUT", TAKEN);
  if (
    deps.customDomainUsed &&
    (await deps.customDomainUsed(domain, row.environment_id))
  )
    throw appsError("BAD_USER_INPUT", TAKEN);
}

/** Writes the domain columns; a concurrent claim of the same domain is BAD_USER_INPUT. */
async function writeDomain(
  deps: AppsDeps,
  row: InstanceRow,
  patch: InstancePatch,
): Promise<InstanceRow> {
  try {
    return await updateInstance(
      deps.db,
      row.id,
      patch,
      deps.now().toISOString(),
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw appsError("BAD_USER_INPUT", TAKEN);
    throw err;
  }
}

/**
 * The holder points their own instance at `domain` (spec 5, 14.2; H4/H5).
 * Holder-only. Applied once DNS points at Vetra (checkDomainsOnce); replacing
 * a domain starts over at `dns` (the old one leaves the document).
 */
export async function setMyInstanceCustomDomain(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  input: string,
): Promise<InstanceCustomDomainJson> {
  const own = await loadOwnInstanceForHolder(deps, caller, instanceId);
  const checked = validateDomain(input);
  if ("error" in checked) throw appsError("BAD_USER_INPUT", checked.error);
  const { domain } = checked;
  await assertFree(deps, domain, own.row);
  const at = deps.now().toISOString();
  const row = await writeDomain(deps, own.row, {
    ...CLEARED,
    custom_domain: domain,
    custom_domain_status: "dns",
    custom_domain_reason: waitingForDns(own.row),
    custom_domain_since: at,
    custom_domain_token: randomBytes(16).toString("hex"),
  });
  // The domain is the holder's public name, so the audit row carries it.
  await auditCaller(deps.db, caller, {
    appId: own.app.id,
    at,
    action: "instance.domain",
    subject: `instance:${own.row.id}`,
    detail: {
      step: "requested",
      domain,
      replaced: own.row.custom_domain ?? null,
    },
  });
  deps.logger.info(
    `[vetra-apps] instance ${own.row.id}: custom domain ${domain} requested by its holder`,
  );
  return customDomainJson(row)!;
}

/** The holder drops their custom domain; the reconciler takes it off the document. */
export async function removeMyInstanceCustomDomain(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<boolean> {
  const own = await loadOwnInstanceForHolder(deps, caller, instanceId);
  if (!own.row.custom_domain) return false;
  await writeDomain(deps, own.row, CLEARED);
  await auditCaller(deps.db, caller, {
    appId: own.app.id,
    at: deps.now().toISOString(),
    action: "instance.domain",
    subject: `instance:${own.row.id}`,
    detail: { step: "removed", domain: own.row.custom_domain },
  });
  return true;
}

const MOVABLE_FROM = new Set([
  "STOPPED",
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

/**
 * Platform admins, for slice 9's switch-over: the custom domain of a licensed
 * environment (stopped first) moves to the holder's own instance. The old
 * environment's domain is cleared first; the instance goes straight to
 * `issuing` (its DNS already points at the cluster).
 */
export async function moveCustomDomainToInstance(
  deps: AppsDeps,
  caller: Caller,
  input: { fromEnvironmentId: string; instanceId: string },
): Promise<InstanceCustomDomainJson> {
  if (!caller.isAdmin)
    throw appsError("FORBIDDEN", "Only platform admins move custom domains");
  const own = await loadOwnInstance(deps, input.instanceId);
  const fromId = input.fromEnvironmentId;
  const domain = await withEnvLock(fromId, async () => {
    const state = await deps.envs.getState(fromId);
    if (!state) throw appsError("NOT_FOUND", "Environment not found");
    if (isInstanceRole(state) || fromId === own.row.environment_id)
      throw appsError(
        "BAD_USER_INPUT",
        "The source must be a licensed environment, not an instance",
      );
    const current = state.customDomain?.enabled
      ? (state.customDomain.domain ?? null)
      : null;
    if (!current)
      throw appsError("BAD_USER_INPUT", "The environment has no custom domain");
    if (!MOVABLE_FROM.has(state.status))
      throw appsError(
        "BAD_USER_INPUT",
        `Stop the environment first (it is ${state.status})`,
      );
    const checked = validateDomain(current);
    if ("error" in checked) throw appsError("BAD_USER_INPUT", checked.error);
    const other = await deps.db
      .selectFrom("instances")
      .select("id")
      .where("custom_domain", "=", checked.domain)
      .where("id", "!=", own.row.id)
      .executeTakeFirst();
    if (other) throw appsError("BAD_USER_INPUT", TAKEN);
    // The one write to a licensed document here, and only this action.
    await deps.envs.execute(fromId, [
      setCustomDomain({ enabled: false, domain: null }),
    ]);
    return checked.domain;
  });
  const at = deps.now().toISOString();
  const row = await writeDomain(deps, own.row, {
    ...CLEARED,
    custom_domain: domain,
    custom_domain_status: "issuing",
    custom_domain_since: at,
  });
  await auditCaller(deps.db, caller, {
    appId: own.app.id,
    at,
    action: "instance.domain",
    subject: `instance:${own.row.id}`,
    detail: { step: "moved", domain, from: fromId },
  });
  return customDomainJson(row)!;
}

async function moveTo(
  deps: AppsDeps,
  row: InstanceRow,
  status: CustomDomainStatus,
  reason: string | null,
  extra: InstancePatch = {},
): Promise<void> {
  const at = deps.now().toISOString();
  await updateInstance(
    deps.db,
    row.id,
    {
      custom_domain_status: status,
      custom_domain_reason: reason,
      custom_domain_since: at,
      ...extra,
    },
    at,
  );
  if (status === "issuing" || status === "active" || status === "failed")
    await recordAudit(deps.db, {
      appId: row.app_id,
      at,
      actor: AUDIT_SYSTEM_ACTOR,
      source: "system",
      action: "instance.domain",
      subject: `instance:${row.id}`,
      detail: {
        step: status === "issuing" ? "applied" : status,
        domain: row.custom_domain,
        ...(reason ? { reason } : {}),
      },
    });
}

const elapsed = (deps: AppsDeps, since: string | null | undefined) =>
  deps.now().getTime() - Date.parse(since ?? "");

async function checkOne(deps: AppsDeps, row: InstanceRow): Promise<void> {
  const probe = deps.domainProbe!;
  const domain = row.custom_domain!;
  const status = row.custom_domain_status;
  if (status === "dns") {
    if (elapsed(deps, row.custom_domain_since) > DNS_WAIT_MS) {
      // Release the claim; a stale never-verified name must not sit on the domain.
      await updateInstance(
        deps.db,
        row.id,
        CLEARED,
        deps.now().toISOString(),
      );
      deps.logger.info(
        `[vetra-apps] instance ${row.id}: ${DNS_NEVER_POINTED} (${domain}); claim released`,
      );
      return;
    }
    const owned =
      !!row.custom_domain_token &&
      (await probe.txt(`${VERIFY_PREFIX}${domain}`)).includes(
        row.custom_domain_token,
      );
    const dns = owned
      ? dnsReady(await probe.a(domain), INGRESS_IP, await probe.aaaa(domain))
      : {
          ready: false,
          reason: `add a TXT record ${VERIFY_PREFIX}${domain} with the value ${row.custom_domain_token ?? "(set the domain again)"}`,
        };
    if (dns.ready) return moveTo(deps, row, "issuing", null);
    const reason = dns.reason ?? waitingForDns(row);
    if (reason !== row.custom_domain_reason)
      await updateInstance(
        deps.db,
        row.id,
        { custom_domain_reason: reason },
        deps.now().toISOString(),
      );
    return;
  }
  if (status === "issuing" || status === "failed") {
    // A domain DNS never reached stays failed until the holder sets it again.
    if (status === "failed" && row.custom_domain_reason === DNS_NEVER_POINTED)
      return;
    if ((await probe.tls(domain)).valid)
      return moveTo(deps, row, "active", null, {
        custom_domain_checked_at: deps.now().toISOString(),
        custom_domain_failures: 0,
      });
    if (
      status === "issuing" &&
      elapsed(deps, row.custom_domain_since) > ISSUING_WAIT_MS
    )
      return moveTo(deps, row, "failed", NO_CERTIFICATE_YET);
    return;
  }
  if (status === "active") {
    if (elapsed(deps, row.custom_domain_checked_at) < ACTIVE_CHECK_EVERY_MS)
      return;
    const valid = (await probe.tls(domain)).valid;
    const failures = valid ? 0 : (row.custom_domain_failures ?? 0) + 1;
    const reason =
      failures >= ACTIVE_FAILURES_REPORTED
        ? `the certificate of ${domain} failed ${failures} daily checks in a row`
        : null;
    await updateInstance(
      deps.db,
      row.id,
      {
        custom_domain_checked_at: deps.now().toISOString(),
        custom_domain_failures: failures,
        custom_domain_reason: reason,
      },
      deps.now().toISOString(),
    );
  }
}

/**
 * Moves custom domains along dns → issuing → active (every minute, plans on).
 * One bad domain never stops the others. Without a probe it does nothing.
 */
export async function checkDomainsOnce(deps: AppsDeps): Promise<number> {
  if (!deps.domainProbe) return 0;
  const rows = await deps.db
    .selectFrom("instances")
    .select("id")
    .where("custom_domain", "is not", null)
    .where("kind", "=", "own")
    .where("status", "!=", "removed")
    .execute();
  let checked = 0;
  for (const { id } of rows) {
    const row = await getInstance(deps.db, id);
    if (!row?.custom_domain) continue;
    try {
      await checkOne(deps, row);
      checked++;
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] custom domain of instance ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return checked;
}
