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

/** What a publisher may change. Absent or null: unchanged; "": clear; links: the whole list. */
export interface AppProfileWrite {
  name?: string | null;
  tagline?: string | null;
  website?: string | null;
  description?: string | null;
  category?: string | null;
  logoRef?: string | null;
  coverRef?: string | null;
  links?: AppProfileLinkInput[] | null;
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
] as const;

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
}

const UPSERT = `mutation UpsertAppProfile($appDid: String!, $name: String, $tagline: String, $website: String, $description: String, $category: String, $logoRef: String, $coverRef: String, $links: [AppProfileLinkInput!]) {
  upsertAppProfile(appDid: $appDid, name: $name, tagline: $tagline, website: $website, description: $description, category: $category, logoRef: $logoRef, coverRef: $coverRef, links: $links)
}`;

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

  return {
    async upsert(appDid, bearer, fields) {
      const variables: Record<string, unknown> = { appDid };
      for (const key of PROFILE_WRITE_KEYS) {
        if (fields[key] !== undefined) variables[key] = fields[key];
      }
      let res: Response;
      try {
        res = await fetchImpl(statsUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`,
            [REGISTRATION_TOKEN_HEADER]: registrationToken,
          },
          body: JSON.stringify({ query: UPSERT, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new RenownProfileError("PROFILE_UNAVAILABLE", UNAVAILABLE);
      }
      const body = (await res.json().catch(() => null)) as UpsertBody;
      const error = body?.errors?.[0];
      if (error) {
        throw refusal(
          error.extensions?.code,
          (error.message ?? "").trim() || "Renown refused the profile.",
          error.extensions?.field,
        );
      }
      if (res.status === 401) throw refusal("UNAUTHENTICATED", "", null);
      if (!res.ok || body?.data?.upsertAppProfile !== true) throw refusal(null, "", null);
    },
  };
}
