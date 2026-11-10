import type { Kysely } from "kysely";

/** Environments in these statuses no longer count as having anything installed. */
export const INSTALL_COUNT_EXCLUDED_STATUSES = [
  "DESTROYED",
  "ARCHIVED",
  "TERMINATING",
] as const;

export type PackageInstallCount = { packageName: string; environments: number };

/**
 * For each package name, how many live environments currently have it
 * installed. Aggregates only: no environment ids, owners or names leave this
 * function.
 *
 * `envDb` is the processor's `vetra-cloud-environments` namespace, a Kysely
 * bound `withSchema`. Only builder calls get schema-qualified, so this stays
 * on the query builder (no raw `sql` table references, which would resolve
 * against `public` and fail).
 *
 * `packages` is stored as JSON text, so the per-package tally happens here
 * rather than in SQL. A package listed twice on one environment counts once.
 * Rows with a NULL status (not yet reported) count as live.
 */
export async function countPackageInstalls(
  envDb: Kysely<any>,
): Promise<PackageInstallCount[]> {
  const rows = (await envDb
    .selectFrom("environments")
    .select(["id", "packages"])
    .where((eb) =>
      eb.or([
        eb("status", "is", null),
        eb("status", "not in", [...INSTALL_COUNT_EXCLUDED_STATUSES]),
      ]),
    )
    .execute()) as Array<{ id: string; packages: string | null }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of packageNames(row.packages)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([packageName, environments]) => ({ packageName, environments }))
    .sort(
      (a, b) =>
        b.environments - a.environments ||
        a.packageName.localeCompare(b.packageName),
    );
}

/** Distinct, non-empty package names from an env's `packages` JSON. */
function packageNames(raw: string | null): Set<string> {
  const names = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return names;
    for (const entry of parsed) {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
  } catch {
    // Unparseable packages JSON: the env contributes nothing.
  }
  return names;
}
