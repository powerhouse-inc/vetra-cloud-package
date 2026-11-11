import { fetchDelegationCredential } from "@renown/sdk/node";
import type { RenownWorkloadConfig } from "./config.js";

/** Client of the Renown workload-identity API (contract C1) + delegation lookup. */
export interface RenownApi {
  registerWorkloadIdentity(input: {
    repositoryId: string;
    repository: string;
    productionBranch: string;
    ownerAddress: string;
    chainId: number;
    /** Register for this Renown organisation (A2). */
    ownerOrgId?: string;
    /** Branches besides productionBranch that may publish releases; sent only when non-empty. */
    releaseBranches?: string[];
  }): Promise<{ did: string; ownerOrgId: string | null }>;
  /** `releaseBranches`, when given, replaces Renown's list ([] clears it). */
  updateWorkloadIdentity(
    did: string,
    patch: {
      repository?: string;
      productionBranch?: string;
      releaseBranches?: string[];
    },
  ): Promise<void>;
  deleteWorkloadIdentity(did: string): Promise<void>;
  /**
   * The owner's newest valid (signed, unexpired, unrevoked) delegation
   * credential for the App's did:key, or null when there is none.
   */
  getDelegation(input: {
    address: string;
    chainId: number;
    did: string;
  }): Promise<{ expiresAt: string | null } | null>;
}

type FetchLike = typeof fetch;

/**
 * Renown refused a registration because the repository's identity was
 * registered by another address (M11).
 */
export function isRenownConflict(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("renown: CONFLICT");
}

/**
 * Renown refused `releaseBranches` as an unknown argument / input field: it
 * predates release branches (renown spec 2026-11-11-workload-release-branches).
 */
export function isRenownReleaseBranchesUnsupported(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith("renown: ") &&
    err.message.includes("releaseBranches") &&
    /Unknown argument|not defined by type|Cannot query field/.test(err.message)
  );
}

export const REGISTRATION_TOKEN_HEADER = "x-renown-workload-registration-token";

export function createRenownApi(
  cfg: RenownWorkloadConfig,
  renownWebUrl: string,
  fetchImpl: FetchLike = fetch,
  fetchDelegation: typeof fetchDelegationCredential = fetchDelegationCredential,
): RenownApi {
  const endpoint = `${cfg.switchboardUrl}/graphql/renown-workload`;

  async function gql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [REGISTRATION_TOKEN_HEADER]: cfg.registrationToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    } | null;
    if (!res.ok || !body || body.errors?.length || !body.data) {
      const err = body?.errors?.[0];
      throw new Error(
        `renown: ${err?.extensions?.code ?? res.status} ${err?.message ?? "request failed"}`,
      );
    }
    return body.data;
  }

  return {
    async registerWorkloadIdentity({ releaseBranches, ...rest }) {
      // An empty list is Renown's default: leave the field out so a Renown
      // without release branches still accepts the registration.
      const input = releaseBranches?.length
        ? { ...rest, releaseBranches }
        : rest;
      const data = await gql<{
        registerWorkloadIdentity: { did: string; ownerOrgId?: string | null };
      }>(
        `mutation Register($input: RegisterWorkloadIdentityInput!) {
          registerWorkloadIdentity(input: $input) { did ownerOrgId }
        }`,
        { input },
      );
      return {
        did: data.registerWorkloadIdentity.did,
        ownerOrgId: data.registerWorkloadIdentity.ownerOrgId ?? null,
      };
    },

    async updateWorkloadIdentity(did, patch) {
      // releaseBranches only when it is being changed: a Renown without
      // release branches keeps accepting the other updates.
      const withList = patch.releaseBranches !== undefined;
      await gql(
        `mutation Update($did: String!, $repository: String, $productionBranch: String${withList ? ", $releaseBranches: [String!]" : ""}) {
          updateWorkloadIdentity(did: $did, repository: $repository, productionBranch: $productionBranch${withList ? ", releaseBranches: $releaseBranches" : ""}) { did }
        }`,
        { did, ...patch },
      );
    },

    async deleteWorkloadIdentity(did) {
      await gql(
        `mutation Delete($did: String!) { deleteWorkloadIdentity(did: $did) }`,
        { did },
      );
    },

    async getDelegation({ address, chainId, did }) {
      // REST lookup on the Renown app (no switchboard discovery), then the
      // SDK re-verifies the credential's EIP-712 proof against the issuer.
      const credential = await fetchDelegation({
        address,
        chainId,
        appDid: did,
        baseUrl: renownWebUrl,
        discover: false,
        verifySignature: true,
      });
      if (!credential) return null;
      return { expiresAt: credential.expirationDate ?? null };
    },
  };
}
