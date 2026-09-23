/**
 * Which service types can own an ingress host, and therefore the env apex
 * (`<subdomain>.vetra.io`).
 *
 * This lives in its own leaf module because the rule has two consumers that
 * must agree: `gitops.effectiveApexType`, which decides the host it WRITES into
 * a tenant's values, and the observability CLINT pull worker, which derives the
 * host it POLLS. When they disagree the worker polls a URL that was never
 * rendered, and agent endpoint discovery goes dark with no error.
 *
 * DOCLING and PAPERLESS are deliberately absent (neither renders an Ingress;
 * PAPERLESS's web UI waits for SSO). DOCLING renders no Ingress at all -- its gitops
 * block is a bare `enabled` flag -- so it can neither serve the apex nor make
 * the apex ambiguous by existing. Counting it would mean that switching the
 * converter on flipped a single-service env's public host from
 * `<subdomain>.vetra.io` to `<subdomain>-<prefix>.vetra.io`, silently moving the
 * tenant's URL as a side effect of enabling a background service.
 *
 * A new routable service type MUST be added here, or it will never claim the
 * apex even when it is the only one enabled.
 */
export const APEX_CAPABLE_TYPES: readonly string[] = [
  "CONNECT",
  "SWITCHBOARD",
  "FUSION",
  "CLINT",
];

const APEX_CAPABLE_SET: ReadonlySet<string> = new Set(APEX_CAPABLE_TYPES);

/** Whether a service type is routable, i.e. eligible to sit at the apex. */
export function isApexCapable(type: string | null | undefined): boolean {
  return !!type && APEX_CAPABLE_SET.has(type);
}
