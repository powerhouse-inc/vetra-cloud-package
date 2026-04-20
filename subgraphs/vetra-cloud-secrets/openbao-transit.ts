import { readFileSync } from "fs";

export type TokenReader = (path: string, encoding: BufferEncoding) => string;

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_TRANSIT_KEY = "vetra-secrets";

export interface OpenBaoTransitClientOptions {
  addr: string;
  role: string;
  keyName?: string;
  tokenReader?: TokenReader;
}

export class OpenBaoTransitClient {
  private readonly addr: string;
  private readonly role: string;
  private readonly keyName: string;
  private readonly readToken: TokenReader;

  constructor(opts: OpenBaoTransitClientOptions) {
    this.addr = opts.addr.replace(/\/$/, "");
    this.role = opts.role;
    this.keyName = opts.keyName ?? DEFAULT_TRANSIT_KEY;
    this.readToken = opts.tokenReader ?? readFileSync;
  }

  async authenticate(): Promise<string> {
    const saToken = this.readToken(SA_TOKEN_PATH, "utf8").trim();
    const res = await fetch(`${this.addr}/v1/auth/kubernetes/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: saToken, role: this.role }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao authentication failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { auth: { client_token: string } };
    return json.auth.client_token;
  }

  async encrypt(plaintext: string): Promise<string> {
    const vaultToken = await this.authenticate();
    const res = await fetch(
      `${this.addr}/v1/transit/encrypt/${encodeURIComponent(this.keyName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": vaultToken,
        },
        body: JSON.stringify({
          plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao transit encrypt failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data: { ciphertext: string } };
    return json.data.ciphertext;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const vaultToken = await this.authenticate();
    const res = await fetch(
      `${this.addr}/v1/transit/decrypt/${encodeURIComponent(this.keyName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": vaultToken,
        },
        body: JSON.stringify({ ciphertext }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenBao transit decrypt failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data: { plaintext: string } };
    return Buffer.from(json.data.plaintext, "base64").toString("utf8");
  }
}
