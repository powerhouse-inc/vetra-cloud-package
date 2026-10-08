// The slice of the vetraLicensing GraphQL API this handler calls. Wire each
// method to the query or mutation of the same name, and let a failed call
// throw an error that carries the GraphQL `extensions.code` (see errorCode).
export interface LicensingClient {
  appLicenses(args: { status: string }): Promise<
    { id: string; user: string; kind: string; status: string }[]
  >;
  appTerms(): Promise<
    { id: string; kind: string; status: string; templateHash: string | null }[]
  >;
  appUserEnvironments(): Promise<
    { environmentId: string; licenseId: string; templateHash: string }[]
  >;
  applyEnvironmentTemplate(input: {
    licenseId: string;
    label: string;
  }): Promise<{ environmentId: string }>;
}

/**
 * The GraphQL error code (`extensions.code`) an error carries, in the shapes
 * common GraphQL clients throw: a GraphQLError, `graphQLErrors[]`, or a
 * `response.errors[]` (graphql-request). Null when there is none.
 */
export function errorCode(err: unknown): string | null {
  const rec = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  const codeOf = (v: unknown): string | null => {
    const code = rec(rec(v)?.extensions)?.code;
    return typeof code === "string" ? code : null;
  };
  const first = (list: unknown): unknown => (Array.isArray(list) ? (list as unknown[])[0] : undefined);
  const e = rec(err);
  return codeOf(e) ?? codeOf(first(e?.graphQLErrors)) ?? codeOf(first(rec(e?.response)?.errors));
}

export interface LicenseHandlerConfig {
  /**
   * Log the plan and change nothing. Defaults to true: read a few ticks of
   * "would apply" before you let this handler act. Set `{ dryRun: false }`
   * when the plan it logs is the one you want.
   */
  dryRun: boolean;
}

/**
 * Makes sure every ACTIVE licence of a DEDICATED term has its environment on
 * the term's current template. Call `reconcileOnce()` from a timer. It keeps
 * no state between runs, so it heals itself after any failure and is safe to
 * run as often as you like: applyEnvironmentTemplate is idempotent per
 * licence chain (a renewal lands on the chain's existing environment).
 *
 * It only ever applies. Vetra's offboarding clock ends environments whose
 * licences have ended (stopped after 14 days, deleted after 90), so a
 * publisher handler never releases anything.
 *
 * Edit this file only if "every active licence gets its term's template" is
 * not the rule you want.
 */
export class LicenseHandler {
  constructor(
    private readonly client: LicensingClient,
    private readonly logger: Pick<Console, "info" | "warn">,
    private readonly config: LicenseHandlerConfig = { dryRun: true },
  ) {}

  async reconcileOnce(): Promise<void> {
    const [licenses, terms, environments] = await Promise.all([
      this.client.appLicenses({ status: "ACTIVE" }),
      this.client.appTerms(),
      this.client.appUserEnvironments(),
    ]);

    // A DRAFT term provisions nothing; a RETIRED one still serves the
    // licences already issued on it.
    const usable = new Map(terms.filter((t) => t.status !== "DRAFT").map((t) => [t.kind, t]));
    const current = new Set(environments.map((e) => `${e.licenseId}:${e.templateHash}`));

    const toApply: { licenseId: string; label: string }[] = [];
    for (const l of licenses) {
      const term = usable.get(l.kind);
      if (!term) {
        this.logger.warn(`[license-handler] licence ${l.id} has kind ${l.kind}, which has no usable term; skipping`);
        continue;
      }
      // A SHARED term (no hash): the holder uses the app's shared environment.
      if (term.templateHash === null) continue;
      if (current.has(`${l.id}:${term.templateHash}`)) continue;
      toApply.push({ licenseId: l.id, label: l.kind });
    }

    if (this.config.dryRun) {
      this.logger.info(
        `[license-handler] dry run: would apply ${toApply.map((a) => a.licenseId).join(", ") || "nothing"}`,
      );
      return;
    }

    for (const input of toApply) {
      try {
        await this.client.applyEnvironmentTemplate(input);
      } catch (err) {
        // BUSY: Vetra is working on that chain right now; nothing was done.
        if (errorCode(err) === "BUSY") {
          this.logger.info(`[license-handler] chain of ${input.licenseId} is busy; retry on the next tick`);
          continue;
        }
        this.logger.warn(`[license-handler] apply for ${input.licenseId} failed: ${String(err)}`);
      }
    }
  }
}
