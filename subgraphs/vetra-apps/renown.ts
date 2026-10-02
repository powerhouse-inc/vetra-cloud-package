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
  }): Promise<{ did: string }>;
  updateWorkloadIdentity(
    did: string,
    patch: { repository?: string; productionBranch?: string },
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
    async registerWorkloadIdentity(input) {
      const data = await gql<{ registerWorkloadIdentity: { did: string } }>(
        `mutation Register($input: RegisterWorkloadIdentityInput!) {
          registerWorkloadIdentity(input: $input) { did }
        }`,
        { input },
      );
      return { did: data.registerWorkloadIdentity.did };
    },

    async updateWorkloadIdentity(did, patch) {
      await gql(
        `mutation Update($did: String!, $repository: String, $productionBranch: String) {
          updateWorkloadIdentity(did: $did, repository: $repository, productionBranch: $productionBranch) { did }
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
