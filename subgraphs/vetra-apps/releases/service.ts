import {
  authorizeCi,
  HARBOR_HOST,
  type AppsDeps,
  type CiIdentity,
} from "../service.js";
import { notConfigured } from "../errors.js";
import { ensureAppNamespace } from "./namespace.js";
import {
  forgetPushRobot,
  pushRobotsOlderThan,
  recordPushRobot,
} from "./repo.js";

const PUSH_TOKEN_MS = 60 * 60 * 1000;

/** Push rights on the app's namespace for one CI run (spec: POST ci/registry-token). */
export async function ciRegistryToken(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
) {
  const app = await authorizeCi(deps, ci, appId);
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  const namespace = await ensureAppNamespace(deps, app);
  await deps.harbor.createProject(namespace); // false = exists: fine, it is ours by name
  const robot = await deps.harbor.createNamespacePushRobot(namespace, 1);
  const now = deps.now();
  await recordPushRobot(deps.db, {
    namespace,
    robotId: robot.id,
    createdAt: now.toISOString(),
  });
  return {
    registry: HARBOR_HOST,
    username: robot.name,
    password: robot.secret,
    repository: `${namespace}/${app.slug}`,
    expiresAt: new Date(now.getTime() + PUSH_TOKEN_MS).toISOString(),
  };
}

/** Deletes push robots older than an hour; Harbor itself only expires them after a day. */
export async function sweepPushRobots(deps: AppsDeps): Promise<number> {
  if (!deps.harbor) return 0;
  const cutoff = new Date(deps.now().getTime() - PUSH_TOKEN_MS).toISOString();
  let n = 0;
  for (const r of await pushRobotsOlderThan(deps.db, cutoff)) {
    try {
      await deps.harbor.deleteRobot(r.robot_id);
      await forgetPushRobot(deps.db, r.robot_id);
      n++;
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] push robot ${r.robot_id} not deleted: ${String(err)}`,
      );
    }
  }
  return n;
}
