import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/** Vetra's own base domains: never a holder's custom domain (plan 7 H5). */
export const VETRA_BASE_DOMAINS: readonly string[] = [
  "vetra.io",
  "staging.vetra.io",
];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const under = (domain: string, base: string) =>
  domain === base || domain.endsWith(`.${base}`);

/**
 * A holder's custom domain, normalised (trimmed, lowercased, one trailing dot
 * dropped, IDNA to ASCII), or why it is refused: not a plain host name of at
 * least two labels, an IP literal, localhost, or under a Vetra base domain
 * (or one of `opts.refused`).
 */
export function validateDomain(
  input: string,
  opts: { refused?: readonly string[] } = {},
): { domain: string } | { error: string } {
  let raw = input.trim().toLowerCase();
  if (raw.endsWith(".")) raw = raw.slice(0, -1);
  if (!raw) return { error: "Enter a domain" };
  if (isIP(raw) || isIP(raw.replace(/^\[|\]$/g, "")))
    return { error: "Use a domain name, not an IP address" };
  if (/[^a-z0-9.\-\u0080-￿]/.test(raw))
    return {
      error:
        "A domain has letters, digits, dashes and dots only (no scheme, path or wildcard)",
    };
  const domain = domainToASCII(raw);
  if (!domain) return { error: "That is not a valid domain name" };
  if (domain.length > 253)
    return { error: "A domain is at most 253 characters" };
  const labels = domain.split(".");
  if (labels.length < 2)
    return { error: "Use a full domain, such as app.example.com" };
  if (!labels.every((l) => LABEL.test(l)))
    return {
      error:
        "Each part of a domain is 1-63 letters, digits or dashes, not starting or ending with a dash",
    };
  if (labels[labels.length - 1] === "localhost")
    return { error: "localhost cannot be a custom domain" };
  for (const base of [...VETRA_BASE_DOMAINS, ...(opts.refused ?? [])])
    if (under(domain, base.toLowerCase()))
      return { error: `Domains under ${base} are Vetra's own` };
  return { domain };
}
