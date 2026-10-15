import { vi } from "vitest";
import type { KeyVault } from "../../vetra-licensing/key-vault.js";

/** In-memory tenant secrets and env vars with the SecretsService method shapes the broker uses. */
export function createFakeSecrets() {
  const secrets = new Map<string, Map<string, string>>();
  const vars = new Map<string, Map<string, string>>();
  const bag = (m: Map<string, Map<string, string>>, t: string) => {
    let b = m.get(t);
    if (!b) {
      b = new Map();
      m.set(t, b);
    }
    return b;
  };
  return {
    setSecret: vi.fn(async (t: string, k: string, v: string) => {
      bag(secrets, t).set(k, v);
      return { key: k };
    }),
    setEnvVar: vi.fn(async (t: string, k: string, v: string) => {
      bag(vars, t).set(k, v);
      return { key: k, value: v };
    }),
    deleteSecret: vi.fn(async (t: string, k: string) =>
      bag(secrets, t).delete(k),
    ),
    listSecretKeys: vi.fn(async (t: string) =>
      [...bag(secrets, t).keys()].sort().map((key) => ({ key })),
    ),
    secret: (t: string, k: string) => secrets.get(t)?.get(k),
    envVar: (t: string, k: string) => vars.get(t)?.get(k),
  };
}

/** Looks like OpenBao transit output, so redaction tests see a realistic ciphertext. */
export const fakeKeyVault: KeyVault = {
  encrypt: async (p) => `vault:v1:${Buffer.from(p).toString("base64")}`,
  decrypt: async (c) =>
    Buffer.from(c.slice("vault:v1:".length), "base64").toString("utf8"),
};

export const holderDid = (
  addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
) => `did:pkh:eip155:1:${addr}`;
