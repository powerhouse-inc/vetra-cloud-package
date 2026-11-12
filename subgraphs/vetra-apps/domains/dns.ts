import { resolve4 } from "node:dns/promises";
import { defaultHostProbe } from "../../vetra-cloud-observability/domain-check.js";

export interface DomainProbe {
  /** A records of the name (CNAMEs followed by the resolver); [] when it does not resolve. */
  a(host: string): Promise<string[]>;
  /** Chain-verified TLS at the host (observability's defaultHostProbe.tls). */
  tls(host: string): Promise<{ valid: boolean; expiresAt: Date | null }>;
}

/** Production probe: the system resolver and a verified TLS handshake on :443. */
export const defaultDomainProbe: DomainProbe = {
  async a(host) {
    try {
      return await resolve4(host);
    } catch {
      return [];
    }
  },
  tls: (host) => defaultHostProbe.tls(host),
};

/**
 * DNS is ready when the domain resolves and every A record of it is the
 * ingress IP: a stray record would break the HTTP-01 challenge.
 */
export function dnsReady(
  records: string[],
  ingressIp: string,
): { ready: boolean; reason: string | null } {
  if (records.length === 0)
    return {
      ready: false,
      reason: `the domain does not resolve yet: point an A record at ${ingressIp}`,
    };
  const stray = records.filter((r) => r !== ingressIp);
  if (stray.length > 0)
    return {
      ready: false,
      reason: `the domain points at ${stray.join(", ")}, not at Vetra (${ingressIp}): remove ${stray.length === 1 ? "that record" : "those records"}`,
    };
  return { ready: true, reason: null };
}
