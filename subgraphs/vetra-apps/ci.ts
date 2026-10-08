import { GraphQLError } from "graphql";
import {
  fetchDelegationCredential,
  verifyAuthBearerToken,
} from "@renown/sdk/node";
import { decodeJwtPayloadUnverified, parseVetraClaim } from "./auth.js";
import { envUrls } from "./envs.js";
import type { DeploymentRow } from "./repo.js";
import { deploymentFields } from "./resolvers.js";
import {
  ciDeployApp,
  ciDeployment,
  ciRecordArtifact,
  ciRegistryCredentials,
  type RecordArtifactInput,
  type AppsDeps,
  type CiIdentity,
  type DeployAppInput,
} from "./service.js";
import { mirrorAppById } from "./app-document.js";

/**
 * CI-facing HTTP routes of vetra-apps, mounted under
 * /api/@powerhousedao/vetra-cloud-package/:
 *
 *   POST apps/ci/registry-credentials  {appId}
 *   POST apps/ci/deploy                DeployAppInput
 *   GET  apps/ci/deployments/:id
 *
 * Renown issues CI (workload) tokens only for VETRA_APPS_CI_AUDIENCE, so the
 * general GraphQL gateway (which verifies another audience) rejects them; the
 * token is verified here instead, with the delegation credential and its
 * EIP-712 proof.
 */

export const DEFAULT_CI_AUDIENCE =
  "https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps";

/** Verified CI caller for a bearer, or null (→ 401). */
/**
 * Result of verifying a CI bearer:
 *  - CiIdentity: valid token with a valid delegation credential;
 *  - { identityExpired }: the token itself is valid (signature, audience,
 *    expiry) but the owner's delegation of its did:key is missing, expired or
 *    revoked — the App needs re-authorizing;
 *  - null: not a valid token (→ 401 UNAUTHENTICATED).
 */
export type CiVerification =
  | CiIdentity
  | { identityExpired: { appDid: string; address: string } }
  | null;

export type CiTokenVerifier = (token: string) => Promise<CiVerification>;

export function createRenownCiVerifier(opts: {
  audience: string;
  /** Renown web app for the credential lookup (SDK default www.renown.id). */
  renownUrl?: string;
  /** Re-verify the credential's EIP-712 proof. Only tests turn this off. */
  verifySignature?: boolean;
}): CiTokenVerifier {
  // The two halves of @renown/sdk verifyAuthCredential, split so a valid
  // token without a delegation can be told apart from an invalid token.
  return async (token) => {
    let address: string;
    let chainId: number;
    let appDid: string;
    try {
      const verified = await verifyAuthBearerToken(token, {
        audience: opts.audience,
      });
      if (!verified) return null;
      const subject = verified.verifiableCredential.credentialSubject;
      address = String(subject.address).toLowerCase();
      chainId = Number(subject.chainId);
      appDid = verified.issuer;
    } catch {
      return null;
    }
    const credential = await fetchDelegationCredential({
      address,
      chainId,
      appDid,
      ...(opts.renownUrl ? { baseUrl: opts.renownUrl } : {}),
      verifySignature: opts.verifySignature ?? true,
    }).catch(() => undefined);
    if (!credential) return { identityExpired: { appDid, address } };
    // Signature checked above: the payload is the verified token's.
    const payload = decodeJwtPayloadUnverified(token);
    return { address, chainId, appDid, claim: parseVetraClaim(payload?.vetra) };
  };
}

export const IDENTITY_EXPIRED_MESSAGE =
  "The App's deploy identity authorization expired — re-authorize it on vetra.io";

/**
 * The App(s) of this identity go PENDING_IDENTITY — but only when the stored
 * expiry is unknown or already past: a lookup miss before the known expiry may
 * be a revocation or a Renown outage, and flipping on an outage would block
 * every deploy until the owner re-confirms.
 */
async function markIdentityExpired(
  deps: AppsDeps,
  appDid: string,
  address: string,
) {
  const nowIso = deps.now().toISOString();
  const expired = await deps.db
    .updateTable("apps")
    .set({ status: "PENDING_IDENTITY", updated_at: nowIso })
    .where("identity_did", "=", appDid)
    .where("owner_address", "=", address)
    .where("status", "=", "ACTIVE")
    .where((eb) =>
      eb.or([
        eb("identity_expires_at", "is", null),
        eb("identity_expires_at", "<=", nowIso),
      ]),
    )
    .returning(["id"])
    .execute();
  for (const row of expired) await mirrorAppById(deps, row.id);
}

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_USER_INPUT: 400,
  PREVIEWS_DISABLED: 400,
  APP_NOT_ACTIVE: 400,
  GITHUB_NOT_CONNECTED: 400,
  SERVICE_NOT_CONFIGURED: 503,
};

const errorResponse = (
  code: string,
  message: string,
  status = STATUS[code] ?? 500,
) => Response.json({ error: code, message }, { status });

class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new HttpError("UNAUTHENTICATED", "Missing bearer token");
  return match[1];
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError("BAD_USER_INPUT", "Body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError("BAD_USER_INPUT", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v)
    throw new HttpError("BAD_USER_INPUT", `${key} is required`);
  return v;
}

export function createCiRoutes(deps: AppsDeps, verify: CiTokenVerifier) {
  async function run(
    request: Request,
    handler: (ci: CiIdentity) => Promise<unknown>,
  ): Promise<Response> {
    try {
      const ci = await verify(bearerToken(request));
      if (!ci)
        throw new HttpError("UNAUTHENTICATED", "Invalid or expired token");
      if ("identityExpired" in ci) {
        await markIdentityExpired(
          deps,
          ci.identityExpired.appDid,
          ci.identityExpired.address,
        );
        return errorResponse("IDENTITY_EXPIRED", IDENTITY_EXPIRED_MESSAGE, 401);
      }
      return Response.json(await handler(ci), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.code, err.message);
      if (err instanceof GraphQLError) {
        const raw = err.extensions.code;
        const code = typeof raw === "string" ? raw : "INTERNAL_SERVER_ERROR";
        return errorResponse(code, err.message);
      }
      deps.logger.warn(`[vetra-apps] CI route failed: ${String(err)}`);
      return errorResponse("INTERNAL_SERVER_ERROR", "Internal error", 500);
    }
  }

  const deploymentJson = async (d: DeploymentRow) => ({
    ...deploymentFields(d),
    urls: envUrls(
      d.environment_id ? await deps.envs.getState(d.environment_id) : null,
    ),
  });

  return {
    registryCredentials: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        return ciRegistryCredentials(deps, ci, requireString(body, "appId"));
      }),

    artifacts: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        const str = (k: string) =>
          {
            const v = body[k];
            return typeof v === "string" ? v : null;
          };
        return ciRecordArtifact(deps, ci, {
          appId: requireString(body, "appId"),
          kind: requireString(body, "kind") as RecordArtifactInput["kind"],
          name: requireString(body, "name"),
          version: requireString(body, "version"),
          reference: requireString(body, "reference"),
          commitSha: str("commitSha"),
          runId: str("runId"),
          channel: str("channel") as RecordArtifactInput["channel"],
        });
      }),

    deploy: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        const input: DeployAppInput = {
          appId: requireString(body, "appId"),
          kind: body.kind as DeployAppInput["kind"],
          prNumber: typeof body.prNumber === "number" ? body.prNumber : null,
          gitRef: typeof body.gitRef === "string" ? body.gitRef : "",
          sha: typeof body.sha === "string" ? body.sha : "",
          runUrl: typeof body.runUrl === "string" ? body.runUrl : null,
          actorGithub:
            typeof body.actorGithub === "string" ? body.actorGithub : null,
          packages: Array.isArray(body.packages)
            ? (body.packages as unknown[]).map((p) => {
                const o = (p ?? {}) as { name?: unknown; version?: unknown };
                return {
                  name: typeof o.name === "string" ? o.name : "",
                  version: typeof o.version === "string" ? o.version : "",
                };
              })
            : (null as never),
          imageTag: typeof body.imageTag === "string" ? body.imageTag : null,
        };
        return deploymentJson(await ciDeployApp(deps, ci, input));
      }),

    deployment: (request: Request, id: string) =>
      run(request, async (ci) => {
        const d = await ciDeployment(deps, ci, id);
        if (!d) throw new HttpError("NOT_FOUND", "Deployment not found");
        return deploymentJson(d);
      }),
  };
}
