import type { AppsDeps } from "../service.js";
import { getHold } from "../holds/repo.js";
import type { InstanceRow } from "../instances/repo.js";
import { getSwitchover } from "./repo.js";
import { parseFingerprints, TENANT_KEYS } from "./keys.js";

/** States after the copy was checked, in which the new instance's app may run (the hold is released in STARTING). */
const RUNS = new Set([
  "STARTING",
  "VERIFYING",
  "LINKING",
  "AWAITING_CONFIRMATION",
  "DONE",
]);

/**
 * Whether the reconciler may set the version of (start) the environment of an
 * instance a switch-over owns. Fails closed. Allowed only when the old
 * environment's two keys are in the new tenant (by fingerprint), and either
 * the environment is held (it then renders its database and /data but no
 * pod) or the copy was checked and the switch-over reached STARTING. The
 * answer is "no" for anything missing, so a new instance is never started on
 * generated keys or on half a copy.
 */
export async function switchoverMayStart(
  deps: AppsDeps,
  row: InstanceRow,
  tenant: string,
): Promise<boolean> {
  if (!row.switchover_id || !row.environment_id) return false;
  const sw = await getSwitchover(deps.db, row.switchover_id);
  if (!sw || !deps.instanceSecrets) return false;
  const fp = parseFingerprints(sw.key_fingerprints);
  if (!fp) return false;
  const held = (await getHold(deps.db, row.environment_id)) !== null;
  const copied = sw.copy_counts !== null && RUNS.has(sw.state);
  if (!held && !copied) return false;
  for (const k of ["master", "attachment"] as const)
    if (
      (await deps.instanceSecrets.secretFingerprint(tenant, TENANT_KEYS[k])) !==
      fp[k]
    )
      return false;
  return true;
}
