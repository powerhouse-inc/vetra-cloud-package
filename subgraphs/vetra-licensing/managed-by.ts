import type { Action } from "document-model";
import {
  setManagedBy,
  type VetraCloudEnvironmentServiceType,
  type VetraCloudEnvironmentState,
} from "document-models/vetra-cloud-environment";
import type { AppDocView } from "./app-reads.js";
import type { LicenseEnvironments } from "./db/schema.js";

/**
 * The environment model's service types, in its own order. `satisfies` fails
 * the build when the model gains a type this list does not name, so a new
 * type cannot silently drop out of the marker (and out of the locks).
 */
const SERVICE_ORDER = {
  CONNECT: true,
  SWITCHBOARD: true,
  FUSION: true,
  CLINT: true,
  DOCLING: true,
  PAPERLESS: true,
  SPECKLE: true,
} satisfies Record<VetraCloudEnvironmentServiceType, true>;
const SERVICE_TYPES = Object.keys(
  SERVICE_ORDER,
) as VetraCloudEnvironmentServiceType[];

export interface ManagedBy {
  appId: string;
  templateId: string;
  rootLicenseId: string;
  /** The service types the template declares: what the reducer locks (spec 4.4). */
  services: VetraCloudEnvironmentServiceType[];
}

/** The marker a chain's environment should carry, or null when its template is unknown or SHARED. */
export function wantedManagedBy(
  row: LicenseEnvironments,
  app: AppDocView,
): ManagedBy | null {
  const template = app.templates.find((t) => t.id === row.template_id);
  if (!template || template.mode !== "DEDICATED") return null;
  const declared = new Set(template.template.services.map((s) => s.type));
  return {
    appId: row.app_id,
    templateId: template.id,
    rootLicenseId: row.root_license_id,
    services: SERVICE_TYPES.filter((t) => declared.has(t)),
  };
}

/** Services compare as sets: an order the document happens to carry is not a change. */
export function sameManagedBy(
  current: VetraCloudEnvironmentState["managedBy"] | undefined,
  wanted: ManagedBy,
): boolean {
  if (!current) return false;
  const services = new Set(current.services);
  return (
    current.appId === wanted.appId &&
    current.templateId === wanted.templateId &&
    current.rootLicenseId === wanted.rootLicenseId &&
    services.size === wanted.services.length &&
    wanted.services.every((s) => services.has(s))
  );
}

export interface ManagedBySyncDeps {
  envs: {
    getState(id: string): Promise<VetraCloudEnvironmentState | null>;
    execute(id: string, actions: Action[]): Promise<unknown>;
  };
  logger: Pick<Console, "warn">;
}

/**
 * Keeps every chain environment's managedBy marker on its template (spec
 * 4.4): set right after a create or a warm claim (the tick that made it),
 * backfilled for environments built before the marker existed, and moved when
 * the chain changes template or the template its services. SET_MANAGED_BY is
 * system-only and leaves the status alone, so it never restarts anything.
 * Only live rows (ended_at null) are marked: `rows` may be all of the app's
 * rows. Each environment's document is read once per process and marker; a
 * DRAFT (not initialised yet) is left for the next tick. Failures are logged
 * per environment and retried next tick; a failure that repeats with the same
 * message is logged once, until the environment is marked or the message
 * changes.
 */
export function createManagedBySync(deps: ManagedBySyncDeps) {
  /** environment id -> the marker this process confirmed on its document. */
  const confirmed = new Map<string, string>();
  /** environment id -> the last failure logged for it. */
  const warned = new Map<string, string>();
  return async (
    app: AppDocView,
    rows: LicenseEnvironments[],
  ): Promise<void> => {
    for (const row of rows) {
      if (row.ended_at !== null) {
        confirmed.delete(row.environment_id);
        warned.delete(row.environment_id);
        continue;
      }
      const wanted = wantedManagedBy(row, app);
      if (!wanted) continue;
      const key = JSON.stringify(wanted);
      if (confirmed.get(row.environment_id) === key) continue;
      try {
        const state = await deps.envs.getState(row.environment_id);
        if (!state || state.status === "DRAFT") continue;
        if (!sameManagedBy(state.managedBy, wanted)) {
          await deps.envs.execute(row.environment_id, [setManagedBy(wanted)]);
        }
        confirmed.set(row.environment_id, key);
        warned.delete(row.environment_id);
      } catch (err) {
        const message = `[licensing] marking environment ${row.environment_id} as managed by app ${app.id} failed: ${String(err)}`;
        if (warned.get(row.environment_id) === message) continue;
        warned.set(row.environment_id, message);
        deps.logger.warn(message);
      }
    }
  };
}
