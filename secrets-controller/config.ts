export interface ControllerConfig {
  databaseUrl: string;
  dbSchema: string | null;
  openbaoAddr: string;
  transitRole: string;
  transitKey: string;
  fullReconcileIntervalMs: number;
  healthPort: number;
  notifyChannel: string;
  managedLabelValue: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): ControllerConfig {
  const parseInt10 = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`invalid numeric env value: ${v}`);
    }
    return n;
  };

  return {
    databaseUrl: required("DATABASE_URL"),
    dbSchema: process.env.DB_SCHEMA || null,
    openbaoAddr: required("OPENBAO_ADDR"),
    transitRole: process.env.OPENBAO_TRANSIT_ROLE ?? "vetra-secrets-controller",
    transitKey: process.env.OPENBAO_TRANSIT_KEY ?? "vetra-secrets",
    fullReconcileIntervalMs: parseInt10(
      process.env.FULL_RECONCILE_INTERVAL_MS,
      5 * 60 * 1000,
    ),
    healthPort: parseInt10(process.env.HEALTH_PORT, 8080),
    notifyChannel: process.env.NOTIFY_CHANNEL ?? "vetra_secrets_changed",
    managedLabelValue: "vetra-secrets-controller",
  };
}
