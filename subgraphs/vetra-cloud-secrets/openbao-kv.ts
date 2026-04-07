import { readFileSync } from "fs";

export type TokenReader = (path: string, encoding: BufferEncoding) => string;

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const ROLE = "vetra-secrets";

export class OpenBaoKVClient {
  private readonly addr: string;
  private readonly readToken: TokenReader;

  constructor(addr: string, tokenReader?: TokenReader) {
    this.addr = addr.replace(/\/$/, "");
    this.readToken = tokenReader ?? readFileSync;
  }

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
    const json = (await res.json()) as { auth: { client_token: string } };
    return json.auth.client_token;
  }

  async readSecrets(tenantId: string): Promise<Record<string, string>> {
    const vaultToken = await this.authenticate();
    const res = await fetch(
      `${this.addr}/v1/kv/data/tenants/${tenantId}/secrets`,
      {
        method: "GET",
        headers: { "X-Vault-Token": vaultToken },
      },
    );
    if (res.status === 404) return {};
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao readSecrets failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      data: { data: Record<string, string> };
    };
    return json.data.data;
  }

  async writeSecrets(
    tenantId: string,
    data: Record<string, string>,
  ): Promise<void> {
    const vaultToken = await this.authenticate();
    const res = await fetch(
      `${this.addr}/v1/kv/data/tenants/${tenantId}/secrets`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": vaultToken,
        },
        body: JSON.stringify({ data }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao writeSecrets failed (${res.status}): ${text}`);
    }
  }

  async deleteSecret(
    tenantId: string,
    key: string,
  ): Promise<Record<string, string>> {
    const existing = await this.readSecrets(tenantId);
    const { [key]: _removed, ...remaining } = existing;
    await this.writeSecrets(tenantId, remaining);
    return remaining;
  }
}
