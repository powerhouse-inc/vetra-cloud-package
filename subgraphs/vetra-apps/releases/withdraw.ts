import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { appsError } from "../errors.js";
import { appInstancesLock } from "../rollouts/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { releaseJson, type ReleaseJson } from "./service.js";

/**
 * Withdraws a release (spec 14.3; decision R6): no plan may target it from
 * now on, policies pass it by, instances still on it are flagged by the
 * console. Never un-withdrawn; the record stays.
 */
export async function withdrawRelease(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  version: string,
  reason: string | null | undefined,
): Promise<ReleaseJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "release" });
  const why = reason?.trim().slice(0, 500) || null;
  return withKeyLock(appInstancesLock(app.id), () =>
    deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .selectFrom("releases")
        .selectAll()
        .where("app_id", "=", app.id)
        .where("version", "=", version)
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw appsError("NOT_FOUND", `The App has no release ${version}`);
      if (r.kind !== "release")
        throw appsError(
          "BAD_USER_INPUT",
          `${version} is a build; builds are pruned, not withdrawn`,
        );
      if (r.withdrawn_at) return releaseJson({ ...r, run: Number(r.run) });
      const targeting = await trx
        .selectFrom("plans")
        .select("slug")
        .where("app_id", "=", app.id)
        .where("target_version", "=", version)
        .execute();
      if (targeting.length > 0)
        throw appsError(
          "BAD_USER_INPUT",
          `${targeting.map((p) => p.slug).join(", ")} ${targeting.length === 1 ? "targets" : "target"} ${version}: roll back its rollout or roll out another release first`,
        );
      const pinned = await trx
        .selectFrom("instances")
        .select("name")
        .where("app_id", "=", app.id)
        .where("pinned_version", "=", version)
        .where("removed_at", "is", null)
        .execute();
      if (pinned.length > 0)
        throw appsError(
          "BAD_USER_INPUT",
          `${pinned.map((i) => i.name).join(", ")} ${pinned.length === 1 ? "is" : "are"} pinned at ${version}: pin elsewhere first`,
        );
      const nowIso = deps.now().toISOString();
      const row = await trx
        .updateTable("releases")
        .set({
          withdrawn_at: nowIso,
          withdrawn_by: caller.address,
          withdrawn_reason: why,
        })
        .where("app_id", "=", app.id)
        .where("version", "=", version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "release.withdrawn",
        subject: `release:${version}`,
        detail: { version, reason: why },
      });
      return releaseJson({ ...row, run: Number(row.run) });
    }),
  );
}
