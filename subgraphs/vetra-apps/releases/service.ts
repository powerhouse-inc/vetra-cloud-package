import {
  authorizeCi,
  HARBOR_HOST,
  loadAppForOwner,
  type AppsDeps,
  type CiIdentity,
} from "../service.js";
import { GraphQLError } from "graphql";
import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { assertReportAllowed } from "./claim.js";
import { ensureAppNamespace } from "./namespace.js";
import {
  forgetPushRobot,
  insertRelease,
  listReleases,
  pushRobotsOlderThan,
  recordPushRobot,
  type ReleaseRow,
} from "./repo.js";

const PUSH_TOKEN_MS = 60 * 60 * 1000;

/** Push rights on the app's namespace (all of that owner's apps) for one CI run; `repository` is where this app pushes (spec: POST ci/registry-token). */
export async function ciRegistryToken(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
) {
  const app = await authorizeCi(deps, ci, appId);
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  const namespace = await ensureAppNamespace(deps, app);
  // false = the project exists. Safe only because ensureAppNamespace has
  // claimed the name for this owner in registry_namespaces (refusing names
  // another owner holds and reserved infrastructure names), and Vetra is the
  // only writer of these project names: an existing one is ours.
  await deps.harbor.createProject(namespace);
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

export interface ReportReleaseInput {
  appId: string;
  version: string;
  kind: "release" | "build";
  branch: string | null;
  pr: number | null;
  commit: string;
  notes: string | null;
  image: { ref: string; digest: string; host: string };
  packages: { name: string; version: string }[];
  requires: { powerhouse?: string; services?: string[]; size?: string };
  migrates: boolean;
  /** What the image was built on: the project's Powerhouse version and the base image digest. */
  built: { powerhouse: string; baseImage: string };
}
export interface ReleaseJson {
  appId: string;
  version: string;
  kind: "release" | "build";
  branch: string | null;
  pr: number | null;
  run: number;
  commit: string;
  notes: string | null;
  customerNotes: string | null;
  image: { ref: string; digest: string; host: string };
  packages: { name: string; version: string }[];
  requires: { powerhouse?: string; services?: string[]; size?: string };
  migrates: boolean;
  built: { powerhouse: string; baseImage: string };
  createdAt: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^[a-z][a-z0-9-]{0,63}$/;

export function releaseJson(r: ReleaseRow): ReleaseJson {
  return {
    appId: r.app_id,
    version: r.version,
    kind: r.kind,
    branch: r.branch,
    pr: r.pr,
    run: Number(r.run),
    commit: r.commit,
    notes: r.notes,
    customerNotes: r.customer_notes,
    image: { ref: r.image_ref, digest: r.image_digest, host: r.host },
    packages: JSON.parse(r.packages) as ReleaseJson["packages"],
    requires: JSON.parse(r.requires) as ReleaseJson["requires"],
    migrates: r.migrates,
    built: { powerhouse: r.powerhouse_version, baseImage: r.base_image },
    createdAt: r.created_at,
  };
}

/** Records a release or build CI built and attested (spec: POST ci/releases). */
export async function ciReportRelease(
  deps: AppsDeps,
  ci: CiIdentity,
  input: ReportReleaseInput,
): Promise<ReleaseJson> {
  const app = await authorizeCi(deps, ci, input.appId);
  const { run } = assertReportAllowed(app, ci.claim, input);

  const namespace = await ensureAppNamespace(deps, app);
  const expectedRef = `${HARBOR_HOST}/${namespace}/${app.slug}:${input.version}`;
  if (input.image.ref !== expectedRef)
    throw appsError("BAD_USER_INPUT", `image.ref must be ${expectedRef}`);
  if (!DIGEST.test(input.image.digest))
    throw appsError("BAD_USER_INPUT", "image.digest must be sha256:<64 hex>");
  if (!HOST.test(input.image.host))
    throw appsError("BAD_USER_INPUT", "image.host must name a host (e.g. cli)");
  const off = input.packages.find((p) => p.version !== input.version);
  if (off)
    throw appsError(
      "BAD_USER_INPUT",
      `${off.name}@${off.version} is not at ${input.version}`,
    );
  if (input.kind === "build" && input.notes !== null)
    throw appsError("BAD_USER_INPUT", "Only a release carries notes");
  if (!input.built.powerhouse || !input.built.baseImage)
    throw appsError(
      "BAD_USER_INPUT",
      "built.powerhouse and built.baseImage are required",
    );

  if (deps.attestations) {
    if (!app.installation_id || !app.repository_full_name)
      throw appsError("FORBIDDEN", "The app has no GitHub installation");
    try {
      await deps.attestations.verify({
        repository: app.repository_full_name,
        digest: input.image.digest,
        commit: input.commit,
        installationId: app.installation_id,
      });
    } catch (err) {
      // A verdict (appsError) is final; anything else is GitHub or the token mint failing.
      if (err instanceof GraphQLError) throw err;
      deps.logger.warn(`[vetra-apps] attestation check failed: ${String(err)}`);
      throw appsError(
        "SERVICE_UNAVAILABLE",
        "Could not reach GitHub to verify the attestation; retry",
      );
    }
  } else if (!deps.cfg.allowUnattestedReleases) {
    throw notConfigured("GitHub attestation verification");
  }

  const { row, created } = await insertRelease(deps.db, {
    app_id: app.id,
    version: input.version,
    kind: input.kind,
    branch: input.branch,
    pr: input.pr,
    run,
    commit: input.commit,
    notes: input.notes,
    customer_notes: input.notes,
    image_ref: input.image.ref,
    image_digest: input.image.digest,
    host: input.image.host,
    packages: JSON.stringify(input.packages),
    requires: JSON.stringify(input.requires),
    migrates: input.migrates,
    powerhouse_version: input.built.powerhouse,
    base_image: input.built.baseImage,
    created_at: deps.now().toISOString(),
  });
  if (!created && row.image_digest !== input.image.digest) {
    throw appsError(
      "VERSION_CONFLICT",
      `${input.version} is already published with another image`,
    );
  }
  if (created) {
    deps.logger.info(
      `[vetra-apps] ${app.slug} ${input.kind} ${input.version} (${input.image.digest.slice(0, 19)})`,
    );
  }
  return releaseJson(row);
}

export async function appReleasesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  kind: string | null | undefined,
  limit: number | null | undefined,
): Promise<ReleaseJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  if (kind != null && kind !== "release" && kind !== "build")
    throw appsError("BAD_USER_INPUT", "kind must be release or build");
  const rows = await listReleases(deps.db, app.id, {
    kind: kind ?? undefined,
    limit: Math.min(Math.max(limit ?? 50, 1), 200),
  });
  return rows.map(releaseJson);
}
