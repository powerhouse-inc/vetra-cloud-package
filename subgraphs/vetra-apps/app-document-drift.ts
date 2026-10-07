import type { Kysely } from "kysely";
import {
  appDocumentFacts,
  type AppDocumentFacts,
  type AppDocStore,
} from "./app-document.js";
import type { VetraAppsDB } from "./db/schema.js";

export interface DriftDeps {
  db: Kysely<VetraAppsDB>;
  docs: Pick<AppDocStore, "getState">;
  logger: Pick<Console, "warn">;
}

export interface DriftReport {
  checked: number;
  /** App ids whose document disagrees with the row, or has no document at all. */
  drifted: string[];
}

export const DRIFT_INTERVAL_MS = 60 * 60_000;

/** How many drifted ids to name in the log before summarising the rest. */
const MAX_NAMED = 20;

/** The document's state, read back in the same shape the row produces. */
function documentFacts(
  state: Record<string, unknown> | null,
): AppDocumentFacts | null {
  if (!state) return null;
  const group = <T>(value: unknown): T | null =>
    value && typeof value === "object" ? (value as T) : null;

  const repository = group<AppDocumentFacts["repository"]>(state.repository);
  const identity = group<AppDocumentFacts["identity"]>(state.identity);
  const previews = group<AppDocumentFacts["previews"]>(state.previews);

  return {
    name: (state.name as string | null) ?? null,
    slug: (state.slug as string | null) ?? null,
    owner: (state.owner as string | null) ?? null,
    repository: {
      repositoryId: repository?.repositoryId ?? null,
      fullName: repository?.fullName ?? null,
      productionBranch: repository?.productionBranch ?? null,
    },
    identity: {
      did: identity?.did ?? null,
      expiresAt: identity?.expiresAt ?? null,
    },
    previews: {
      enabled: Boolean(previews?.enabled),
      limit: previews?.limit ?? 0,
      ttlDays: previews?.ttlDays ?? 0,
    },
    productionEnvironmentId:
      (state.productionEnvironmentId as string | null) ?? null,
    status:
      (state.status as AppDocumentFacts["status"] | null) ??
      ("" as AppDocumentFacts["status"]),
  };
}

/** The field paths on which the two disagree. Empty means they agree. */
export function factsDiff(
  row: AppDocumentFacts,
  doc: AppDocumentFacts | null,
): string[] {
  if (!doc) return ["<document missing>"];
  const out: string[] = [];
  for (const key of Object.keys(row) as (keyof AppDocumentFacts)[]) {
    if (JSON.stringify(row[key]) !== JSON.stringify(doc[key])) out.push(key);
  }
  return out;
}

/**
 * Compares every app row against its document and reports what disagrees.
 *
 * **Logs, never repairs.** This step exists to prove the dual-write is correct;
 * silent repair would hide the write bug that caused the drift, and the row is
 * still what every read is served from.
 *
 * A document that cannot be read is drift, not a crash: one unreachable
 * document must not stop the rest of the sweep.
 */
export async function reportAppDocumentDrift(
  deps: DriftDeps,
): Promise<DriftReport> {
  const rows = await deps.db.selectFrom("apps").selectAll().execute();

  const drifted: string[] = [];
  for (const row of rows) {
    const expected = appDocumentFacts(row);
    let diff: string[];
    try {
      diff = factsDiff(
        expected,
        documentFacts(await deps.docs.getState(row.id)),
      );
    } catch (err) {
      diff = [`<unreadable: ${String(err)}>`];
    }
    if (diff.length > 0) {
      drifted.push(row.id);
      deps.logger.warn(
        `[vetra-apps] app ${row.slug} (${row.id}) differs from its document: ${diff.join(", ")}`,
      );
    }
  }

  if (drifted.length > 0) {
    const named = drifted.slice(0, MAX_NAMED).join(", ");
    const rest =
      drifted.length > MAX_NAMED
        ? ` and ${drifted.length - MAX_NAMED} more`
        : "";
    deps.logger.warn(
      `[vetra-apps] ${drifted.length}/${rows.length} app documents drifted: ${named}${rest}`,
    );
  }
  return { checked: rows.length, drifted };
}
