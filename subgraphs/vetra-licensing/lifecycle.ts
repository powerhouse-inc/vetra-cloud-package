import type { Action } from "document-model";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";
import type { LicenseStatusName } from "./transitions.js";

/** What a batch of lifecycle actions leaves a licence as. */
export interface LifecycleChange {
  status: LicenseStatusName;
  /** Present only when the batch issued the licence. */
  end?: string | null;
  replacedBy?: string | null;
}

const input = (a: Action): Record<string, unknown> =>
  typeof a.input === "object" && a.input !== null ? (a.input as Record<string, unknown>) : {};

/**
 * Derived from the actions the system sent, never from the document: the
 * final lifecycle status of the batch, or null when it carries no lifecycle
 * action (SET_STAGE, MIGRATE_LICENSE).
 */
export function lifecycleOf(actions: Action[]): LifecycleChange | null {
  let change: LifecycleChange | null = null;
  for (const a of actions) {
    switch (a.type) {
      case "ISSUE_LICENSE": {
        const end = input(a).end;
        change = { status: "ISSUED", end: typeof end === "string" ? end : null };
        break;
      }
      case "ACTIVATE_LICENSE":
        change = { ...(change ?? {}), status: "ACTIVE" };
        break;
      case "EXPIRE_LICENSE":
        change = { ...(change ?? {}), status: "EXPIRED" };
        break;
      case "REVOKE_LICENSE":
        change = { ...(change ?? {}), status: "REVOKED" };
        break;
      case "REPLACE_LICENSE": {
        const by = input(a).replacedBy;
        change = { ...(change ?? {}), status: "REPLACED", replacedBy: typeof by === "string" ? by : null };
        break;
      }
    }
  }
  return change;
}

export interface LifecycleRecord {
  status: string;
  replacedBy: string | null;
}

export type LifecycleStore = ReturnType<typeof createLifecycleStore>;

/** `license_lifecycle`: the authoritative lifecycle status of every licence the system wrote. */
export function createLifecycleStore(db: Kysely<VetraLicensingDB>, now: () => string) {
  return {
    /** Records what `actions` (already applied) left the licence as. No-op for non-lifecycle batches. */
    async record(licenseId: string, actions: Action[]): Promise<void> {
      const change = lifecycleOf(actions);
      if (!change) return;
      const at = now();
      const patch: { status: string; updated_at: string; end_at?: string | null; replaced_by?: string | null } = {
        status: change.status,
        updated_at: at,
      };
      if (change.end !== undefined) patch.end_at = change.end;
      if (change.replacedBy !== undefined) patch.replaced_by = change.replacedBy;
      await db
        .insertInto("license_lifecycle")
        .values({
          license_id: licenseId,
          status: change.status,
          end_at: change.end ?? null,
          replaced_by: change.replacedBy ?? null,
          updated_at: at,
        })
        .onConflict((oc) => oc.column("license_id").doUpdateSet(patch))
        .execute();
    },
    async all(): Promise<Map<string, LifecycleRecord>> {
      const rows = await db
        .selectFrom("license_lifecycle")
        .select(["license_id", "status", "replaced_by"])
        .execute();
      return new Map(rows.map((r) => [r.license_id, { status: r.status, replacedBy: r.replaced_by }]));
    },
  };
}
