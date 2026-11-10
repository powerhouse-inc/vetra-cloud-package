import type { Kysely } from "kysely";
import {
  routedGenericHosts,
  type GenericHostState,
} from "../../processors/vetra-cloud-environment/gitops.js";

/**
 * Public host lookup (`vetraEnvironmentHostKnown`): is `host` a generated
 * `<subdomain>[-<prefix>].<baseDomain>` host of a live Vetra environment?
 * The Sektar OAuth relay asks this before it forwards a Google sign-in code
 * to a host, so it is never an open redirect.
 *
 * Custom-domain hosts always answer false. SET_CUSTOM_DOMAIN stores whatever
 * domain the owner types, and nothing persisted proves that domain routes to
 * Vetra: the observability watcher's domainResolves / tlsCertValid only say
 * the host resolves somewhere and serves some valid certificate (an apex
 * custom domain of `google.com` would be green). Answering true for those
 * would let any env owner point the relay at a host they do not run on Vetra.
 *
 * Answers only a boolean: malformed input, an unknown host and a failing
 * read model all answer false.
 */

/** Statuses of environments that are gone or going: their hosts are not known. */
const RELEASED_STATUSES = ["TERMINATING", "DESTROYED", "ARCHIVED"] as const;

/** Input longer than this is refused before any parsing (253 + ":" + port + "."). */
const MAX_INPUT_LENGTH = 260;
const MAX_HOST_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** At most this many env rows are looked at for one host (subdomains are unique in practice). */
const MAX_ROWS = 25;

/**
 * Lowercase, strip a port, strip one trailing dot. Null for anything that is
 * not a DNS host name of at least two valid labels (IPs in brackets, spaces,
 * empty labels, over-long names or labels).
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_INPUT_LENGTH)
    return null;
  let host = raw.toLowerCase();
  const port = /:\d{1,5}$/.exec(host);
  if (port) host = host.slice(0, port.index);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return host;
}

/**
 * Subdomains a generated host can belong to: its first label (apex host) and
 * every part of it before a "-" (`<subdomain>-<prefix>`).
 */
export function candidateSubdomains(host: string): string[] {
  const first = host.split(".")[0] ?? "";
  const out = [first];
  for (let i = first.indexOf("-"); i > 0; i = first.indexOf("-", i + 1)) {
    out.push(first.slice(0, i));
  }
  return out;
}

type HostRow = {
  subdomain: string | null;
  genericBaseDomain: string | null;
  apexService: string | null;
  customDomain: string | null;
  customDomainEnabled: boolean | null;
  services: string | null;
  fusion: string | null;
};

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The state fields routedGenericHosts reads, rebuilt from a read-model row. */
function hostStateOf(row: HostRow): GenericHostState {
  const services = parseJson(row.services);
  return {
    genericSubdomain: row.subdomain,
    genericBaseDomain: row.genericBaseDomain,
    apexService: row.apexService,
    services: Array.isArray(services) ? (services as GenericHostState["services"]) : [],
    customDomain: {
      enabled: row.customDomainEnabled === true,
      domain: row.customDomain,
      dnsRecords: [],
    },
    fusion: parseJson(row.fusion),
  } as GenericHostState;
}

/**
 * `envDb` is the processor's `vetra-cloud-environments` namespace. One query
 * on the indexed `subdomain` column per call.
 */
export async function isKnownEnvironmentHost(
  envDb: Kysely<any>,
  rawHost: unknown,
  logger: Pick<Console, "warn"> = console,
): Promise<boolean> {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  try {
    const rows = (await envDb
      .selectFrom("environments")
      .select([
        "subdomain",
        "genericBaseDomain",
        "apexService",
        "customDomain",
        "customDomainEnabled",
        "services",
        "fusion",
      ])
      .where("subdomain", "in", candidateSubdomains(host))
      .where((eb) =>
        eb.or([
          eb("status", "is", null),
          eb("status", "not in", [...RELEASED_STATUSES]),
        ]),
      )
      .limit(MAX_ROWS)
      .execute()) as HostRow[];
    return rows.some((row) =>
      routedGenericHosts(hostStateOf(row)).some((h) => h.toLowerCase() === host),
    );
  } catch (err) {
    logger.warn(`[vetra-cloud-observability] host lookup failed: ${String(err)}`);
    return false;
  }
}
