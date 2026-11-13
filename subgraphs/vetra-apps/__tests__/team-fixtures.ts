import { DEFAULT_INSTANCE_HEALTH } from "../config.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan, type PlanRow } from "../plans/repo.js";
import { appForOwner } from "../service.js";
import {
  admin,
  APP_DID,
  makeHarness,
  MEMBER,
  ORG,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";

export const ORG_ADMIN_A = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const ORG_ADMIN_B = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export const ORG_MEMBER = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

/** Plans and health enforce on, the App in ORG, releases 1.0.0 (run 100) and 1.1.0 (run 101) on main. */
export async function teamHarness(
  over: { gate?: boolean } = {},
): Promise<{ h: Harness; appId: string }> {
  const h = await makeHarness(
    testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { ...DEFAULT_INSTANCE_HEALTH, mode: "enforce" },
      },
      plans: { enabled: true, stopAfterDays: 14, teamSoakMinutes: 30 },
      ...(over.gate
        ? {
            gate: {
              enabled: true,
              url: "https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check",
              minPowerhouse: "6.2.3-dev.102",
            },
          }
        : {}),
    }),
  );
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  // Into the org (as org-apps.test.ts moveToOrg does).
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  await appForOwner(h.deps, admin, appId);
  h.orgs.join(ORG, OWNER, "OWNER");
  h.orgs.join(ORG, ORG_ADMIN_A, "ADMIN");
  h.orgs.join(ORG, ORG_MEMBER, "MEMBER");
  h.orgs.join(ORG, MEMBER, "MEMBER");
  await seedRelease(h, appId, {
    version: "1.0.0",
    run: 100,
    kind: "release",
    digest: digest("a"),
  });
  await seedRelease(h, appId, {
    version: "1.1.0",
    run: 101,
    kind: "release",
    digest: digest("b"),
  });
  return { h, appId };
}

export const seedTeamPlan = (
  h: Harness,
  appId: string,
  over: Partial<PlanRow> = {},
) =>
  insertPlan(h.db, {
    id: "p-team",
    app_id: appId,
    slug: "team",
    name: "Team",
    kind: null,
    team: true,
    access: "shared",
    size: "VETRA_AGENT_S",
    target_version: "1.0.0",
    policy: "follow:main",
    notice_hours: 0,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  });

export const teamRow = async (h: Harness, appId: string) =>
  (await listInstances(h.db, appId, "shared")).find(
    (r) => r.plan_id === "p-team",
  ) ?? null;
