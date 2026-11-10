/**
 * Runs every step in order, even when an earlier one throws, then rethrows:
 * a single failure as it is, several as one AggregateError whose message
 * lists each (a stable text, so a repeated failure is logged once).
 */
export async function runAll(
  steps: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `${failures.length} steps failed: ${failures.map(String).join("; ")}`,
    );
  }
}
