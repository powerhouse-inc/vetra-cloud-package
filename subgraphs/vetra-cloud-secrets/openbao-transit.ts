import { readFileSync } from "fs";

export type TokenReader = (path: string, encoding: BufferEncoding) => string;

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_KEY_NAME_PREFIX = "vetra-tenant-";
// Re-auth 5 min before the token TTL runs out so decrypts-in-flight don't race.
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface OpenBaoTransitClientOptions {
  addr: string;
  role: string;
  keyNamePrefix?: string;
  tokenReader?: TokenReader;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class OpenBaoTransitClient {
  private readonly addr: string;
  private readonly role: string;
  private readonly keyNamePrefix: string;
  private readonly readToken: TokenReader;
  private tokenCache: CachedToken | null = null;

  constructor(opts: OpenBaoTransitClientOptions) {
    this.addr = opts.addr.replace(/\/$/, "");
    this.role = opts.role;
    this.keyNamePrefix = opts.keyNamePrefix ?? DEFAULT_KEY_NAME_PREFIX;
    this.readToken = opts.tokenReader ?? readFileSync;
  }

  keyFor(tenantId: string): string {
    return `${this.keyNamePrefix}${tenantId}`;
  }

  async ensureTenantKey(tenantId: string): Promise<void> {
    const key = this.keyFor(tenantId);
    const token = await this.getToken();
    const res = await fetch(
      `${this.addr}/v1/transit/keys/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": token,
        },
        body: JSON.stringify({
          type: "aes256-gcm96",
          deletion_allowed: false,
        }),
      },
    );
    // 204 = created; 400 with "existing key" also acceptable (idempotent).
    if (res.status === 204) return;
    const text = await res.text();
    if (res.status === 400 && /existing key/i.test(text)) return;
    if (!res.ok) {
      throw new Error(
        `OpenBao ensureTenantKey(${tenantId}) failed (${res.status}): ${text}`,
      );
    }
  }

  async encrypt(tenantId: string, plaintext: string): Promise<string> {
    const key = this.keyFor(tenantId);
    const token = await this.getToken();
    const res = await fetch(
      `${this.addr}/v1/transit/encrypt/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": token,
        },
        body: JSON.stringify({
          plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao transit encrypt(${tenantId}) failed (${res.status}): ${text}`,
      );
    }
    const json = (await res.json()) as { data: { ciphertext: string } };
    return json.data.ciphertext;
  }

  async decrypt(tenantId: string, ciphertext: string): Promise<string> {
    const key = this.keyFor(tenantId);
    const token = await this.getToken();
    const res = await fetch(
      `${this.addr}/v1/transit/decrypt/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": token,
        },
        body: JSON.stringify({ ciphertext }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenBao transit decrypt(${tenantId}) failed (${res.status}): ${text}`,
      );
    }
    const json = (await res.json()) as { data: { plaintext: string } };
    return Buffer.from(json.data.plaintext, "base64").toString("utf8");
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
    const json = (await res.json()) as {
      auth: { client_token: string; lease_duration: number };
    };
    const ttlMs = Math.max(json.auth.lease_duration, 60) * 1000;
    this.tokenCache = {
      token: json.auth.client_token,
      expiresAt: Date.now() + ttlMs - TOKEN_EXPIRY_BUFFER_MS,
    };
    return json.auth.client_token;
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }
    return this.authenticate();
  }
}
