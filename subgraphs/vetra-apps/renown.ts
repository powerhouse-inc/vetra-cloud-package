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
  /** Has the owner signed the delegation credential for the App's did:key? */
  hasDelegation(input: {
    address: string;
    chainId: number;
    did: string;
  }): Promise<boolean>;
}

type FetchLike = typeof fetch;

export const REGISTRATION_TOKEN_HEADER = "x-renown-workload-registration-token";

export function createRenownApi(
  cfg: RenownWorkloadConfig,
  renownWebUrl: string,
  fetchImpl: FetchLike = fetch,
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

    async hasDelegation({ address, chainId, did }) {
      const url = new URL("/api/auth/credential", renownWebUrl);
      url.searchParams.set("address", address);
      url.searchParams.set("chainId", String(chainId));
      url.searchParams.set("connectId", did);
      url.searchParams.set("appId", did);
      const res = await fetchImpl(url, { method: "GET" });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as {
        credential?: {
          issuer?: { id?: string };
          credentialSubject?: { id?: string };
          expirationDate?: string;
        } | null;
      } | null;
      const cred = body?.credential;
      if (!cred || cred.credentialSubject?.id !== did) return false;
      // issuer.id = did:pkh:eip155:<chainId>:<address>
      const [, , , issuerChain, issuerAddress] = (cred.issuer?.id ?? "").split(
        ":",
      );
      if (issuerChain !== String(chainId)) return false;
      if (issuerAddress?.toLowerCase() !== address.toLowerCase()) return false;
      if (cred.expirationDate) {
        const exp = Date.parse(cred.expirationDate);
        if (Number.isNaN(exp) || exp <= Date.now()) return false;
      }
      return true;
    },
  };
}
