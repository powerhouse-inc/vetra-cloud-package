import {
  generateConfigMapYaml,
  generateExternalSecretYaml,
} from "../gitops-sync.js";

describe("generateConfigMapYaml", () => {
  it("generates a ConfigMap with all env vars", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", [
      { key: "NODE_ENV", value: "production" },
      { key: "LOG_LEVEL", value: "info" },
    ]);

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("name: my-tenant-1234abcd-env");
    expect(yaml).toContain('NODE_ENV: "production"');
    expect(yaml).toContain('LOG_LEVEL: "info"');
  });

  it("generates an empty-data ConfigMap when no env vars", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", []);

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("name: my-tenant-1234abcd-env");
    expect(yaml).toContain("data: {}");
  });

  it("escapes special YAML characters in values", () => {
    const yaml = generateConfigMapYaml("my-tenant-1234abcd", [
      { key: "MSG", value: 'hello "world"\nnewline' },
    ]);

    expect(yaml).toContain("MSG:");
    // Value should be quoted and escaped — no raw newline inside the value
    expect(yaml).not.toContain("hello \"world\"\nnewline");
  });
});

describe("generateExternalSecretYaml", () => {
  it("generates an ExternalSecret referencing all secret keys", () => {
    const yaml = generateExternalSecretYaml("my-tenant-1234abcd", [
      "API_KEY",
      "DB_PASSWORD",
    ]);

    expect(yaml).toContain("kind: ExternalSecret");
    expect(yaml).toContain("name: my-tenant-1234abcd-secrets");
    expect(yaml).toContain("secretStoreRef:");
    expect(yaml).toContain("name: openbao");
    expect(yaml).toContain("kind: ClusterSecretStore");
    expect(yaml).toContain("secretKey: API_KEY");
    expect(yaml).toContain("secretKey: DB_PASSWORD");
    expect(yaml).toContain("key: tenants/my-tenant-1234abcd/secrets");
    expect(yaml).toContain("property: API_KEY");
    expect(yaml).toContain("property: DB_PASSWORD");
  });

  it("generates ExternalSecret with empty data when no secrets", () => {
    const yaml = generateExternalSecretYaml("my-tenant-1234abcd", []);

    expect(yaml).toContain("kind: ExternalSecret");
    expect(yaml).toContain("data: []");
  });
});
