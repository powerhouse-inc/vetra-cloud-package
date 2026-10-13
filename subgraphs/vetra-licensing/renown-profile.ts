import { REGISTRATION_TOKEN_HEADER } from "../vetra-apps/renown.js";

/**
 * The Renown app-profile relay (identity hub phase 2).
 *
 * renown-stats writes an app profile only for a caller that presents BOTH the
 * publisher's own Renown bearer (Authorization; its wallet must own the app's
 * workload identity) AND the workload registration token Vetra already holds
 * (X-Renown-Workload-Registration-Token). Browser bearers are signed by random
 * per-browser keys, so Renown cannot tell vetra.io from any other site; the
 * token can. vetra.io calls vetraPublisher.updateAppProfile, Vetra checks the
 * caller owns the app, then forwards here to
 *   mutation { upsertAppProfile(appDid: String!, …): Boolean! }
 */

export interface AppProfileLinkInput {
  id: string;
  label: string;
  url: string;
}

export type MetricAggregation = "SUM" | "MAX" | "AVG" | "COUNT_USERS";

/** A publisher-defined metric (Renown's AppMetricInput). */
export interface AppProfileMetricInput {
  id: string;
  key: string;
  label: string;
  unit?: string | null;
  description?: string | null;
  aggregation: MetricAggregation;
  public: boolean;
}

/** What a publisher may change. Absent or null: unchanged; "": clear; links and metrics: the whole list. */
export interface AppProfileWrite {
  name?: string | null;
  tagline?: string | null;
  website?: string | null;
  description?: string | null;
  category?: string | null;
  logoRef?: string | null;
  coverRef?: string | null;
  links?: AppProfileLinkInput[] | null;
  metrics?: AppProfileMetricInput[] | null;
  supportContact?: string | null;
  securityContact?: string | null;
  /** First claim of an org-owned app: the organisation. */
  publisherOrgId?: string | null;
}

export const PROFILE_WRITE_KEYS = [
  "name",
  "tagline",
  "website",
  "description",
  "category",
  "logoRef",
  "coverRef",
  "links",
  "metrics",
  "supportContact",
  "securityContact",
  "publisherOrgId",
] as const;
export type ProfileWriteKey = (typeof PROFILE_WRITE_KEYS)[number];

/** A refusal shown to the publisher: `code` is the wire code, `field` the input to fix. */
export class RenownProfileError extends Error {
  override name = "RenownProfileError";
  constructor(
    readonly code: string,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

export interface RenownProfileRelay {
  /** Writes `fields` to `appDid`'s profile as the bearer's wallet. Throws RenownProfileError. */
  upsert(appDid: string, bearer: string, fields: AppProfileWrite): Promise<void>;
}

export interface RenownProfileRelayConfig {
  /** RENOWN_STATS_URL. Null: profiles off. */
  statsUrl: string | null;
  /** RENOWN_WORKLOAD_REGISTRATION_TOKEN. Null: profiles off. */
  registrationToken: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, "warn">;
}

const ARG_TYPES: Record<ProfileWriteKey, string> = {
  name: "String", tagline: "String", website: "String", description: "String", category: "String",
  logoRef: "String", coverRef: "String", links: "[AppProfileLinkInput!]", metrics: "[AppMetricInput!]",
  supportContact: "String", securityContact: "String", publisherOrgId: "String",
};

/** The mutation for exactly these arguments, so older Renowns accept writes that do not use newer ones. */
export function upsertMutation(keys: readonly ProfileWriteKey[]): string {
  const defs = ["$appDid: String!", ...keys.map((k) => `$${k}: ${ARG_TYPES[k]}`)].join(", ");
  const args = ["appDid: $appDid", ...keys.map((k) => `${k}: $${k}`)].join(", ");
  return `mutation UpsertAppProfile(${defs}) {\n  upsertAppProfile(${args})\n}`;
}

const UNAVAILABLE = "Renown is not reachable right now. Try again in a minute.";

/** Renown's answer, as the publisher surface states it. */
function refusal(code: unknown, message: string, field: unknown): RenownProfileError {
  switch (code) {
    case "BAD_USER_INPUT":
    case "INVALID_IMAGE":
      return new RenownProfileError("INVALID_INPUT", message, typeof field === "string" ? field : null);
    case "FORBIDDEN":
      return new RenownProfileError(
        "FORBIDDEN",
        "Renown refused: this wallet does not own the app's Renown identity.",
      );
    case "APP_FROZEN":
      return new RenownProfileError("APP_FROZEN", "This app is frozen by its organisation.");
    case "RATE_LIMITED":
      return new RenownProfileError("RATE_LIMITED", "Too many profile saves. Wait a minute and try again.");
    case "UNAUTHENTICATED":
      return new RenownProfileError("UNAUTHENTICATED", "Your login has expired. Log in again and retry.");
    default:
      return new RenownProfileError("PROFILE_UNAVAILABLE", UNAVAILABLE);
  }
}

type UpsertBody = {
  data?: { upsertAppProfile?: unknown } | null;
  errors?: { message?: string; extensions?: { code?: unknown; field?: unknown } }[];
} | null;

export function createRenownProfileRelay(cfg: RenownProfileRelayConfig): RenownProfileRelay | null {
  if (!cfg.statsUrl || !cfg.registrationToken) return null;
  const statsUrl = cfg.statsUrl;
  const registrationToken = cfg.registrationToken;
  const fetchImpl = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const logger = cfg.logger ?? console;
  /** Operators need the cause; the publisher gets the generic message. Never log the bearer or token. */
  const unavailable = (cause: string): RenownProfileError => {
    logger.warn(`[licensing] renown app profile unavailable (${cause})`);
    return new RenownProfileError("PROFILE_UNAVAILABLE", UNAVAILABLE);
  };

  return {
    async upsert(appDid, bearer, fields) {
      const keys = PROFILE_WRITE_KEYS.filter((k) => fields[k] !== undefined);
      const variables: Record<string, unknown> = { appDid };
      for (const key of keys) variables[key] = fields[key];
      let res: Response;
      try {
        res = await fetchImpl(statsUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`,
            [REGISTRATION_TOKEN_HEADER]: registrationToken,
          },
          body: JSON.stringify({ query: upsertMutation(keys), variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw unavailable("network");
      }
      const body = (await res.json().catch(() => null)) as UpsertBody;
      const error = body?.errors?.[0];
      if (error) {
        const refused = refusal(
          error.extensions?.code,
          (error.message ?? "").trim() || "Renown refused the profile.",
          error.extensions?.field,
        );
        if (refused.code === "PROFILE_UNAVAILABLE") {
          const code = error.extensions?.code;
          throw unavailable(`Renown error ${typeof code === "string" ? code : "without a code"}`);
        }
        throw refused;
      }
      if (res.status === 401) throw refusal("UNAUTHENTICATED", "", null);
      if (!res.ok) throw unavailable(`HTTP ${res.status}`);
      if (body?.data?.upsertAppProfile !== true) throw unavailable("validation: unexpected response shape");
    },
  };
}
