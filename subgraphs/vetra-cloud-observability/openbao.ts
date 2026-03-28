import { readFileSync } from "fs";

export interface K8sCredentials {
  token: string;
  leaseId: string;
  leaseDuration: number;
}

const SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const ROLE = "vetra-observability";

export type TokenReader = (path: string, encoding: BufferEncoding) => string;

export class OpenBaoClient {
  private readonly addr: string;
  private readonly readToken: TokenReader;

  constructor(addr: string, tokenReader?: TokenReader) {
    this.addr = addr.replace(/\/$/, "");
    this.readToken = tokenReader ?? readFileSync;
  }

  /**
   * Authenticates with OpenBao using the Kubernetes auth method.
   * Reads the service account token from the pod's mounted secret.
   * Returns the vault client token on success.
   */
  async authenticate(): Promise<string> {
    const saToken = this.readToken(SA_TOKEN_PATH, "utf8").trim();

    const res = await fetch(`${this.addr}/v1/auth/kubernetes/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: saToken, role: ROLE }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao authentication failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as {
      auth: { client_token: string };
    };
    return json.auth.client_token;
  }

  /**
   * Retrieves a short-lived Kubernetes token from OpenBao.
   * Authenticates first to obtain a vault token.
   */
  async getK8sToken(): Promise<K8sCredentials> {
    const vaultToken = await this.authenticate();

    const res = await fetch(
      `${this.addr}/v1/kubernetes/creds/${ROLE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": vaultToken,
        },
        body: JSON.stringify({
          kubernetes_namespace: process.env.OPENBAO_K8S_NAMESPACE || "staging",
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao getK8sToken failed (${res.status}): ${text}`,
      );
    }

    const json = (await res.json()) as {
      data: { service_account_token: string };
      lease_id: string;
      lease_duration: number;
    };

    return {
      token: json.data.service_account_token,
      leaseId: json.lease_id,
      leaseDuration: json.lease_duration,
    };
  }

  /**
   * Revokes a lease in OpenBao, invalidating the associated token.
   */
  async revokeLease(leaseId: string): Promise<void> {
    const vaultToken = await this.authenticate();

    const res = await fetch(`${this.addr}/v1/sys/leases/revoke`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": vaultToken,
      },
      body: JSON.stringify({ lease_id: leaseId }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao revokeLease failed (${res.status}): ${text}`,
      );
    }
  }

  /**
   * Renews a lease in OpenBao, extending the TTL of the associated token.
   */
  async renewLease(leaseId: string): Promise<void> {
    const vaultToken = await this.authenticate();

    const res = await fetch(`${this.addr}/v1/sys/leases/renew`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": vaultToken,
      },
      body: JSON.stringify({ lease_id: leaseId }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao renewLease failed (${res.status}): ${text}`,
      );
    }
  }
}
