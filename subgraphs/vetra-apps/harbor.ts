import { randomBytes } from "node:crypto";
import type { HarborAppsConfig } from "./config.js";

/** Harbor v2.0 admin calls for Vetra Apps: one private project + push robot per App. */
export interface HarborApi {
  /**
   * Create the private project. true = created by us; false = it already
   * exists (409) — the caller must pick another name, never reuse it.
   */
  createProject(project: string): Promise<boolean>;
  /** A never-expiring project-scoped robot with push + pull. */
  createPushRobot(
    project: string,
  ): Promise<{ id: number; name: string; secret: string }>;
  /**
   * A push+pull robot on the whole `project` (all of that namespace's
   * repositories; Harbor cannot scope robots below a project), expiring after
   * `durationDays` (Harbor counts whole days).
   */
  createNamespacePushRobot(
    project: string,
    durationDays: number,
  ): Promise<{ id: number; name: string; secret: string }>;
  /** Delete a robot (CI loses push access); an already-gone robot is fine. */
  deleteRobot(id: number): Promise<void>;
  /**
   * Delete a project this process just created (a failed createApp, before
   * anything was pushed); an already-gone project is fine.
   */
  deleteProject(project: string): Promise<void>;
  /**
   * Makes the project's stable release tags immutable (RELEASE_TAG_RULE),
   * once: true = the rule was added, false = the project already had it.
   */
  ensureImmutableReleaseTags(project: string): Promise<boolean>;
}

/**
 * Harbor's immutable tag rule for a namespace project: no tag without a `-`
 * may be overwritten or deleted, in any repository. vetra-publish tags
 * images with the version: a stable release is `X.Y.Z`, a prerelease
 * `X.Y.Z-beta.N`, a build `X.Y.Z-main.N`. Licensed environments pull a
 * release by its tag, so it must never move. Harbor's doublestar selector
 * cannot say "X.Y.Z" exactly (`*` also matches `-`, `[0-9]*.[0-9]*.[0-9]*`
 * covers builds too), so the rule excludes `*-*` (tags with a `-`) instead.
 * One selector per dimension, as every Harbor 2.x evaluates it. Builds and
 * prereleases stay mutable; vetra-publish never re-pushes an existing tag
 * anyway.
 */
export const RELEASE_TAG_RULE = {
  action: "immutable",
  template: "immutable_template",
  disabled: false,
  scope_selectors: {
    repository: [
      { kind: "doublestar", decoration: "repoMatches", pattern: "**" },
    ],
  },
  tag_selectors: [
    { kind: "doublestar", decoration: "excludes", pattern: "*-*" },
  ],
};

type Selector = { kind?: string; decoration?: string; pattern?: string };
const sameSelectors = (a: Selector[] | undefined, b: Selector[]) =>
  (a ?? []).length === b.length &&
  b.every(
    (x, i) =>
      a![i]?.kind === x.kind &&
      a![i]?.decoration === x.decoration &&
      a![i]?.pattern === x.pattern,
  );

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
    async ensureImmutableReleaseTags(project) {
      const url = `${cfg.url}/api/v2.0/projects/${encodeURIComponent(project)}/immutabletagrules`;
      const headers = {
        authorization: auth,
        accept: "application/json",
        "x-is-resource-name": "true",
      };
      const list = await fetchImpl(url, { method: "GET", headers });
      if (!list.ok)
        throw new Error(
          `harbor: immutable tag rules of ${project} → ${list.status}`,
        );
      const rules = (await list.json()) as Array<{
        scope_selectors?: { repository?: Selector[] };
        tag_selectors?: Selector[];
      }>;
      const has = rules.some(
        (r) =>
          sameSelectors(
            r.scope_selectors?.repository,
            RELEASE_TAG_RULE.scope_selectors.repository,
          ) && sameSelectors(r.tag_selectors, RELEASE_TAG_RULE.tag_selectors),
      );
      if (has) return false;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(RELEASE_TAG_RULE),
      });
      if (!res.ok)
        throw new Error(
          `harbor: add immutable tag rule to ${project} → ${res.status}`,
        );
      return true;
    },

    async createProject(project) {
      const res = await post("/projects", {
        project_name: project,
        metadata: { public: "false" },
      });
      if (res.ok) return true;
      if (res.status === 409) return false;
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
      const body = (await res.json()) as {
        id: number;
        name: string;
        secret: string;
      };
      return { id: body.id, name: body.name, secret: body.secret };
    },

    async createNamespacePushRobot(project, durationDays) {
      const name = `vetra-ci-${randomBytes(4).toString("hex")}`;
      const res = await post("/robots", {
        name,
        description: "Vetra CI push token",
        level: "project",
        duration: durationDays,
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
      const body = (await res.json()) as {
        id: number;
        name: string;
        secret: string;
      };
      return { id: body.id, name: body.name, secret: body.secret };
    },

    async deleteRobot(id) {
      const res = await fetchImpl(`${cfg.url}/api/v2.0/robots/${id}`, {
        method: "DELETE",
        headers: { authorization: auth, accept: "application/json" },
      });
      if (res.ok || res.status === 404) return;
      throw new Error(`harbor: delete robot ${id} → ${res.status}`);
    },

    async deleteProject(project) {
      const res = await fetchImpl(
        `${cfg.url}/api/v2.0/projects/${encodeURIComponent(project)}`,
        {
          method: "DELETE",
          headers: {
            authorization: auth,
            accept: "application/json",
            "x-is-resource-name": "true",
          },
        },
      );
      if (res.ok || res.status === 404) return;
      throw new Error(`harbor: delete project ${project} → ${res.status}`);
    },
  };
}
