import { randomBytes } from "node:crypto";
import type { HarborAppsConfig } from "./config.js";

/** Harbor v2.0 admin calls for Vetra Apps: one private project + push robot per App. */
export interface HarborApi {
  /** Create the private project; an existing project (409) is fine. */
  ensureProject(project: string): Promise<void>;
  /** A never-expiring project-scoped robot with push + pull. */
  createPushRobot(project: string): Promise<{ name: string; secret: string }>;
}

type FetchLike = typeof fetch;

export function createHarborApi(
  cfg: HarborAppsConfig,
  fetchImpl: FetchLike = fetch,
): HarborApi {
  const auth = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`;
  const post = async (path: string, body: unknown) =>
    fetchImpl(`${cfg.url}/api/v2.0${path}`, {
      method: "POST",
      headers: {
        authorization: auth,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  return {
    async ensureProject(project) {
      const res = await post("/projects", {
        project_name: project,
        metadata: { public: "false" },
      });
      if (res.ok || res.status === 409) return;
      throw new Error(`harbor: create project ${project} → ${res.status}`);
    },

    async createPushRobot(project) {
      // Random suffix: robot names are unique per project, and a retry after a
      // half-finished createApp must not collide with the first robot.
      const name = `vetra-deploy-${randomBytes(3).toString("hex")}`;
      const res = await post("/robots", {
        name,
        description: "Vetra Apps CI push robot",
        level: "project",
        duration: -1,
        permissions: [
          {
            kind: "project",
            namespace: project,
            access: [
              { resource: "repository", action: "push" },
              { resource: "repository", action: "pull" },
            ],
          },
        ],
      });
      if (!res.ok)
        throw new Error(`harbor: create robot for ${project} → ${res.status}`);
      const body = (await res.json()) as { name: string; secret: string };
      return { name: body.name, secret: body.secret };
    },
  };
}
