export interface TenantEnvVars {
  tenantId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface TenantSecrets {
  tenantId: string;
  key: string;
  updatedAt: string;
  ciphertext: string | null;
}

export interface SecretsDB {
  tenant_env_vars: TenantEnvVars;
  tenant_secrets: TenantSecrets;
}
