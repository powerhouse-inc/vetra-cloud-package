/**
 * Kysely DB types for the runtime-config subgraph.
 *
 * Single table — one row per tenant. The `value` column holds the JSON-encoded
 * `connect.*` subtree of `powerhouse.config.json`. Columns match the
 * conventions in `vetra-cloud-secrets/db/schema.ts` (camelCase varchar, ISO
 * string for `updatedAt`).
 */
export interface TenantRuntimeConfig {
  tenantId: string;
  value: string;
  updatedAt: string;
}

export interface RuntimeConfigDB {
  tenant_runtime_config: TenantRuntimeConfig;
}
