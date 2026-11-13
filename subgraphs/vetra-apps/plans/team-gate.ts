import { RenownOrgsUnavailableError } from "../../../shared/renown-orgs.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { isOrgApp } from "./team-base.js";

/**
 * The licence gate's answer for the Team instance (decision D8): the owning
 * organisation's ACTIVE members get in (decision T3). Per address, never a
 * member list. Renown failures throw: the gate answers 503 and the host keeps
 * its grace for people it admitted before.
 */
export async function teamGateAnswer(
  deps: AppsDeps,
  app: AppRow,
  address: string,
): Promise<{ allowed: boolean; reason: "member" | "none" }> {
  if (!isOrgApp(app)) return { allowed: false, reason: "none" };
  if (!deps.orgs)
    throw new RenownOrgsUnavailableError(
      "Renown organisations are not configured",
    );
  const m = await deps.orgs.membership(
    app.owner_org_id!,
    address.toLowerCase(),
  );
  return m
    ? { allowed: true, reason: "member" }
    : { allowed: false, reason: "none" };
}
