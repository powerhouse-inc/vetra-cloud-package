import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  addPackage,
  approveChanges,
  setOwnerOrg,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { up as upSecrets } from "../../vetra-cloud-secrets/db/migrations.js";
import type { SecretsDB } from "../../vetra-cloud-secrets/db/schema.js";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  type SecretsService,
} from "../../vetra-cloud-secrets/services/secrets-service.js";
import type { Caller } from "../auth.js";
import { envUrls, subdomainsCollide } from "../envs.js";
import { getApp, getAppByIdentity, type AppRow } from "../repo.js";
import { resolveCallerApp } from "../../vetra-licensing/auth.js";
import { up } from "../db/migrations.js";
import { createResolvers } from "../resolvers.js";
import {
  appForOwner,
  appRegistryCredentials,
  confirmAppIdentity,
  connectGithubDeploy,
  createStudioApp,
  deleteApp,
  deployApp,
  ensureStudioProduct,
  myApps,
  openAppSetupPullRequest,
  studioProductFor,
  STUDIO_PRODUCT_IDENTITY_PREFIX,
  type EnsureStudioProductInput,
  type StudioProductAuth,
} from "../service.js";
import {
  hashLaunchSecret,
  STUDIO_LAUNCH_SECRET_KEY,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
} from "../studio-binding.js";
import {
  reportDeploymentToGithub,
  reportPreviewRemovedToGithub,
  runDeploymentWatcherOnce,
  runPreviewSweepOnce,
  removeUnlaunchedStudioApp,
  runUnlaunchedStudioAppSweepOnce,
} from "../watcher.js";
import {
  claim,
  deployAsCi,
  INSTALLATION,
  makeHarness,
  MEMBER,
  member,
  ORG,
  OWNER,
  owner,
  seedActiveApp,
  STRANGER,
  stranger,
  type Harness,
} from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
/** The Studio agent: its own did:key, acting for the owner under a delegation. */
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const FUTURE = "2027-10-02T12:00:00.000Z";
const DAY = 86_400_000;

const OWNER_AUTH: StudioProductAuth = { kind: "owner" };
const agentAuth = (secret: string | null): StudioProductAuth => ({ kind: "agent", secret });

let h: Harness;
let secretsDb: Kysely<SecretsDB>;
let secrets: SecretsService;
const transit = {
  authenticate: vi.fn(),
  ensureTenantKey: vi.fn().mockResolvedValue(undefined),
  keyFor: vi.fn(),
  encrypt: vi.fn(async (tenantId: string, plaintext: string) => `vault:v1:${tenantId}:${plaintext}`),
  decrypt: vi.fn(),
} as unknown as OpenBaoTransitClient;

beforeEach(async () => {
  h = await makeHarness();
  h.renown.delegation = { expiresAt: FUTURE };
  secretsDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(new PGlite()) });
  await upSecrets(secretsDb);
  secrets = createSecretsService({ db: secretsDb, transit });
  h.deps.studioSecrets = secrets;
  // The env read model, as the fake envs hold it.
  h.deps.subdomainTaken = async (candidate) => {
    for (const doc of h.envs.docs.values()) {
      const sub = doc.state.global.genericSubdomain;
      if (sub && subdomainsCollide(candidate, sub)) return true;
    }
    return false;
  };
});
afterEach(async () => {
  await h.close();
  await secretsDb.destroy();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

/** A claimed Studio of `address`; with `secret`, its launch secret is recorded. */
async function seedStudio(opts: { address?: string; secret?: boolean } = {}) {
  const id = await h.envs.seedStandalone(opts.address ?? OWNER);
  await h.envs.execute(id, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  let secret: string | null = null;
  if (opts.secret !== false) {
    secret = randomBytes(32).toString("hex");
    await storeLaunchSecretHash(h.db, id, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
  }
  return { id, secret };
}

const ensure = (
  input: EnsureStudioProductInput,
  caller: Caller = owner,
  auth: StudioProductAuth = OWNER_AUTH,
) => ensureStudioProduct(h.deps, caller, input, auth);

const tenantOf = async (envId: string) =>
  getTenantId((await h.envs.getState(envId))!.genericSubdomain!, envId);

/** The launch secret as the Studio's pod reads it after the restart. */
async function tenantLaunchSecret(envId: string): Promise<string | undefined> {
  const tenantId = await tenantOf(envId);
  const row = await secretsDb
    .selectFrom("tenant_secrets")
    .select("ciphertext")
    .where("tenantId", "=", tenantId)
    .where("key", "=", STUDIO_LAUNCH_SECRET_KEY)
    .executeTakeFirst();
  return row?.ciphertext?.replace(`vault:v1:${tenantId}:`, "");
}

const appCount = async () =>
  (await h.db.selectFrom("apps").select("id").execute()).length;

/** Logged lines never carry `secret`. */
function expectNotLogged(secret: string) {
  for (const fn of Object.values(h.deps.logger) as ReturnType<typeof vi.fn>[]) {
    for (const call of fn.mock.calls) expect(String(call[0])).not.toContain(secret);
  }
}

describe("ensureStudioProduct", () => {
  it("creates an App without a repository and a production env at <slug>.vetra.io with Connect at the apex", async () => {
    const studio = await seedStudio();
    const envsBefore = h.envs.docs.size;
    const app = await ensure({ studioEnvironmentId: studio.id, name: "My Shop" });

    expect(app).toMatchObject({
      slug: "my-shop",
      name: "My Shop",
      status: "ACTIVE",
      owner_address: OWNER,
      owner_org_id: null,
      studio_environment_id: studio.id,
      installation_id: null,
      repository_id: null,
      repository_full_name: null,
      previews_enabled: false,
      harbor_project: "app-my-shop",
      harbor_robot_id: null,
      identity_did: `${STUDIO_PRODUCT_IDENTITY_PREFIX}${studio.id}`,
      product_drive_id: null,
      launched_at: null,
      adopted_at: null,
    });
    // No GitHub, no Renown workload identity, no Harbor robot.
    expect(Object.keys(h.github.calls)).toStrictEqual([]);
    expect(h.renown.registered).toStrictEqual([]);
    expect(h.harbor.projects).toStrictEqual(["app-my-shop"]);

    // One new env: the product's, at <slug>.vetra.io, Connect at the apex.
    expect(h.envs.docs.size).toBe(envsBefore + 1);
    const env = (await h.envs.getState(app.production_environment_id))!;
    expect(env).toMatchObject({
      label: "My Shop",
      genericSubdomain: "my-shop",
      genericBaseDomain: "vetra.io",
      owner: OWNER,
      apexService: "CONNECT",
      defaultPackageRegistry: "https://registry.vetra.io",
      app: { appId: app.id, role: "PRODUCTION", imageProject: "app-my-shop" },
      status: "CHANGES_APPROVED",
    });
    expect(env.services.filter((s) => s.enabled).map((s) => s.type).sort()).toStrictEqual([
      "CONNECT",
      "SWITCHBOARD",
    ]);
    expect(envUrls(env)).toStrictEqual({
      app: null,
      connect: "https://my-shop.vetra.io",
      switchboard: "https://my-shop-switchboard.vetra.io",
    });
    // The Studio itself is never linked.
    expect((await h.envs.getState(studio.id))!.app).toBeNull();
  });

  it("second call returns the same App", async () => {
    const studio = await seedStudio();
    const first = await ensure({ studioEnvironmentId: studio.id, name: "My Shop" });
    const envs = h.envs.docs.size;
    // A new name changes nothing: the address is fixed at the first call (D19).
    const again = await ensure({ studioEnvironmentId: studio.id, name: "Renamed" });
    expect(again.id).toBe(first.id);
    expect(again.slug).toBe("my-shop");
    // The agent gets the same App, now bound to its key.
    const viaAgent = await ensure(
      { studioEnvironmentId: studio.id, name: "My Shop" },
      agent,
      agentAuth(studio.secret),
    );
    expect(viaAgent.id).toBe(first.id);
    expect(viaAgent.identity_did).toBe(AGENT_KEY);
    expect(h.envs.docs.size).toBe(envs);
    expect(await appCount()).toBe(1);
    expect(h.harbor.projects).toStrictEqual(["app-my-shop"]);
  });

  it("concurrent calls make one App", async () => {
    const studio = await seedStudio();
    const made = await Promise.all(
      [1, 2, 3].map(() => ensure({ studioEnvironmentId: studio.id, name: "My Shop" })),
    );
    expect(new Set(made.map((a) => a.id)).size).toBe(1);
    expect(await appCount()).toBe(1);
  });

  it("slug taken gets a suffix", async () => {
    // Another App holds the slug.
    const first = await seedStudio();
    await ensure({ studioEnvironmentId: first.id, name: "My Shop" });
    const second = await seedStudio();
    const b = await ensure({ studioEnvironmentId: second.id, name: "My Shop" });
    expect(b.slug).toBe("my-shop-2");
    expect((await h.envs.getState(b.production_environment_id))!.genericSubdomain).toBe("my-shop-2");

    // An env's hosts hold it (an env "rapid-fox" serves rapid-fox-connect…).
    const legacy = await h.envs.seedStandalone(STRANGER);
    const legacySub = (await h.envs.getState(legacy))!.genericSubdomain!;
    const third = await seedStudio();
    const c = await ensure({ studioEnvironmentId: third.id, name: legacySub });
    expect(c.slug).toBe(`${legacySub}-2`);

    // A platform host is never taken.
    const fourth = await seedStudio();
    const d = await ensure({ studioEnvironmentId: fourth.id, name: "Registry" });
    expect(d.slug).toBe("registry-2");

    // Someone else's Harbor project.
    h.harbor.existing.add("app-garden");
    const fifth = await seedStudio();
    const e = await ensure({ studioEnvironmentId: fifth.id, name: "Garden" });
    expect(e.slug).toBe("garden-2");
  });

  it("org Studio creates an org App", async () => {
    h.orgs.join(ORG, MEMBER, "PUBLISHER", "ALL");
    const studio = await seedStudio();
    await h.envs.execute(studio.id, [setOwnerOrg({ ownerOrgId: ORG, operators: [MEMBER] })]);
    const app = await ensure({ studioEnvironmentId: studio.id, name: "Team Shop" }, member);
    expect(app).toMatchObject({ owner_org_id: ORG, owner_address: OWNER, status: "ACTIVE" });
    const env = (await h.envs.getState(app.production_environment_id))!;
    expect(env).toMatchObject({
      ownerOrgId: ORG,
      orgOperators: [MEMBER],
      apexService: "CONNECT",
      genericSubdomain: "team-shop",
    });
    // The hand-over was announced, so the observability protection keeps it.
    const announced = await h.obsDb
      .selectFrom("org_expected_handovers")
      .select("documentId")
      .execute();
    expect(announced.length).toBeGreaterThan(0);
    // A non-member may not.
    const other = await seedStudio();
    await h.envs.execute(other.id, [setOwnerOrg({ ownerOrgId: ORG, operators: [MEMBER] })]);
    expect(await code(ensure({ studioEnvironmentId: other.id, name: "X" }, stranger))).toBe("FORBIDDEN");
  });

  it("refuses what is not the caller's Studio, bad names and App identities", async () => {
    const studio = await seedStudio();
    expect(await code(ensure({ studioEnvironmentId: studio.id, name: "X" }, stranger))).toBe("FORBIDDEN");
    const plain = await h.envs.seedStandalone();
    expect(await code(ensure({ studioEnvironmentId: plain, name: "X" }))).toBe("BAD_USER_INPUT");
    expect(await code(ensure({ studioEnvironmentId: studio.id, name: "  " }))).toBe("BAD_USER_INPUT");
    expect(await code(ensure({ studioEnvironmentId: " ", name: "X" }))).toBe("BAD_USER_INPUT");
    h.deps.harbor = null;
    expect(await code(ensure({ studioEnvironmentId: studio.id, name: "X" }))).toBe("SERVICE_NOT_CONFIGURED");
    expect(await appCount()).toBe(0);
  });

  it("a failed env step undoes the row, the env and the Harbor project", async () => {
    const studio = await seedStudio();
    const execute = h.envs.execute.bind(h.envs);
    vi.spyOn(h.envs, "execute").mockImplementation(async (id, actions) => {
      if (id !== studio.id) throw new Error("reactor down");
      return execute(id, actions);
    });
    expect(await code(ensure({ studioEnvironmentId: studio.id, name: "My Shop" }))).toBe(
      "DEPLOY_SETUP_FAILED",
    );
    expect(await appCount()).toBe(0);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(h.envs.deleted).toHaveLength(1);
  });
});

describe("ensureStudioProduct on the Studio-agent path (D20)", () => {
  it("the agent creates its own Studio's product, bound to its key; owner-only paths refuse it", async () => {
    const studio = await seedStudio();
    const app = await ensure(
      { studioEnvironmentId: studio.id, name: "My Shop" },
      agent,
      agentAuth(studio.secret),
    );
    expect(app).toMatchObject({ identity_did: AGENT_KEY, status: "ACTIVE", repository_id: null });
    // assertNotWorkload: the agent may not act as the owner on the App.
    expect(await code(appForOwner(h.deps, agent, app.id))).toBe("FORBIDDEN");
    expect(await code(deleteApp(h.deps, agent, app.id, true))).toBe("FORBIDDEN");
    expect(await code(deployApp(h.deps, agent, {
      appId: app.id, kind: "PRODUCTION", gitRef: "refs/heads/main", sha: "abcdef1234567", packages: [],
    }))).toBe("FORBIDDEN");
    // The owner in person still can.
    expect(await code(appForOwner(h.deps, owner, app.id))).toBe("OK");
  });

  it("refuses a wrong secret, another Studio's secret, an expired delegation and a stranger", async () => {
    const mine = await seedStudio();
    const other = await seedStudio();
    const input = { studioEnvironmentId: mine.id, name: "My Shop" };
    expect(await code(ensure(input, agent, agentAuth(other.secret)))).toBe("STUDIO_BINDING");
    expect(await code(ensure(input, agent, agentAuth(randomBytes(32).toString("hex"))))).toBe("STUDIO_BINDING");
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("STUDIO_BINDING");
    expect(await code(ensure(input, { ...agent, appKey: null }, agentAuth(mine.secret)))).toBe("DELEGATION_MISSING");
    expect(await code(ensure(input, { ...agent, address: STRANGER }, agentAuth(mine.secret)))).toBe("STUDIO_BINDING");
    h.renown.delegation = null;
    expect(await code(ensure(input, agent, agentAuth(mine.secret)))).toBe("DELEGATION_EXPIRED");
    expect(await appCount()).toBe(0);
  });

  it("a Studio without a launch secret gets one: the first agent call is refused once, the retry after the restart passes", async () => {
    const studio = await seedStudio({ secret: false });
    const input = { studioEnvironmentId: studio.id, name: "My Shop" };
    const ensureSpy = vi.spyOn(secrets, "ensureSecret");
    const replace = vi.spyOn(secrets, "replaceTenantConfig");

    // The agent has no secret yet: it sends the header empty.
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("STUDIO_SECRET_PENDING");
    expect(await appCount()).toBe(0);
    // One key written through the single-key path; its hash recorded.
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    const secret = (await tenantLaunchSecret(studio.id))!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await h.db
      .selectFrom("studio_launch_secrets")
      .select("secret_hash")
      .where("environment_id", "=", studio.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_hash).toBe(hashLaunchSecret(secret));

    // Before the restart the agent still has nothing: refused, nothing rewritten.
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("STUDIO_BINDING");
    expect(await tenantLaunchSecret(studio.id)).toBe(secret);

    // After the restart (Reloader) it presents the secret.
    const app = await ensure(input, agent, agentAuth(secret));
    expect(app).toMatchObject({ identity_did: AGENT_KEY, studio_environment_id: studio.id });
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expectNotLogged(secret);
  });

  it("only a caller who could pass the binding provisions a secret, and only one is written", async () => {
    const studio = await seedStudio({ secret: false });
    const input = { studioEnvironmentId: studio.id, name: "My Shop" };
    // Not the Studio's owner, no agent key, or no current delegation: nothing written.
    expect(await code(ensure(input, { ...agent, address: STRANGER }, agentAuth(null)))).toBe("STUDIO_BINDING");
    expect(await code(ensure(input, { ...agent, appKey: null }, agentAuth(null)))).toBe("DELEGATION_MISSING");
    h.renown.delegation = null;
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("DELEGATION_EXPIRED");
    expect(await tenantLaunchSecret(studio.id)).toBeUndefined();
    h.renown.delegation = { expiresAt: FUTURE };

    // Concurrent first calls: one secret, matching the one hash.
    const set = vi.spyOn(secrets, "setManagedSecret");
    const results = await Promise.all([1, 2, 3].map(() => code(ensure(input, agent, agentAuth(null)))));
    expect(results).toContain("STUDIO_SECRET_PENDING");
    for (const r of results) expect(["STUDIO_SECRET_PENDING", "STUDIO_BINDING"]).toContain(r);
    expect(set).not.toHaveBeenCalled();
    const secret = (await tenantLaunchSecret(studio.id))!;
    expect(await code(ensure(input, agent, agentAuth(secret)))).toBe("OK");
  });

  it("a failed tenant write leaves no hash, so the next call provisions again", async () => {
    const studio = await seedStudio({ secret: false });
    const input = { studioEnvironmentId: studio.id, name: "My Shop" };
    vi.spyOn(secrets, "ensureSecret").mockRejectedValueOnce(new Error("openbao down"));
    expect(await code(ensure(input, agent, agentAuth(null)))).not.toBe("OK");
    expect(await h.db.selectFrom("studio_launch_secrets").select("environment_id").execute()).toHaveLength(0);
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("STUDIO_SECRET_PENDING");
  });

  it("only the agent path provisions the secret: the owner's call never restarts the Studio", async () => {
    const studio = await seedStudio({ secret: false });
    const ensureSpy = vi.spyOn(secrets, "ensureSecret");
    await ensure({ studioEnvironmentId: studio.id, name: "My Shop" });
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(await tenantLaunchSecret(studio.id)).toBeUndefined();
    // The agent provisions it, then after the restart gets the owner's App, bound to its key.
    const input = { studioEnvironmentId: studio.id, name: "My Shop" };
    expect(await code(ensure(input, agent, agentAuth(null)))).toBe("STUDIO_SECRET_PENDING");
    const secret = (await tenantLaunchSecret(studio.id))!;
    const app = await ensure(input, agent, agentAuth(secret));
    expect(app.identity_did).toBe(AGENT_KEY);
    expectNotLogged(secret);
  });

  it("an agent key bound to a live App gets no second one; after a sweep the successor owns the key", async () => {
    const first = await seedStudio();
    const old = await ensure({ studioEnvironmentId: first.id, name: "Old" }, agent, agentAuth(first.secret));
    // The same key on another Studio of the owner: refused while the first App is live.
    const second = await seedStudio();
    expect(
      await code(ensure({ studioEnvironmentId: second.id, name: "New" }, agent, agentAuth(second.secret))),
    ).toBe("STUDIO_BINDING");

    h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(1);
    const successor = await ensure(
      { studioEnvironmentId: first.id, name: "Old" },
      agent,
      agentAuth(first.secret),
    );
    expect(successor.id).not.toBe(old.id);
    expect(successor.identity_did).toBe(AGENT_KEY);
    // Every identity lookup resolves the live App, not the DELETED one.
    expect((await getAppByIdentity(h.db, AGENT_KEY))!.id).toBe(successor.id);
    const licensing = await resolveCallerApp(
      {
        findAppByIdentityDid: (did) =>
          getAppByIdentity(h.db, did).then((r) => (r ? { id: r.id, status: r.status } : null)),
      },
      { user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: AGENT_KEY } },
    );
    expect(licensing).toStrictEqual({ appId: successor.id });
    // The owner-only paths still refuse the agent.
    expect(await code(appForOwner(h.deps, agent, successor.id))).toBe("FORBIDDEN");
  });
});

describe("adopting an existing env (F28)", () => {
  it("adopts the existing env as production without creating one", async () => {
    const studio = await seedStudio();
    const old = await h.envs.seedStandalone(OWNER);
    const oldSub = (await h.envs.getState(old))!.genericSubdomain;
    const envs = h.envs.docs.size;
    const app = await ensure(
      { studioEnvironmentId: studio.id, name: "My Shop", adoptEnvironmentId: old },
      agent,
      agentAuth(studio.secret),
    );
    expect(h.envs.docs.size).toBe(envs);
    expect(h.envs.deleted).toStrictEqual([]);
    expect(app).toMatchObject({ production_environment_id: old, adopted_at: expect.any(String) });
    const env = (await h.envs.getState(old))!;
    // Its address stays: existing links keep working.
    expect(env).toMatchObject({
      genericSubdomain: oldSub,
      apexService: "CONNECT",
      app: { appId: app.id, role: "PRODUCTION" },
      owner: OWNER,
    });
    // A settled env is re-approved with the link.
    expect(h.envs.executed.at(-1)).toStrictEqual({ id: old, types: ["APPROVE_CHANGES"] });
  });

  it("refuses the Studio itself, another owner's env, another App's env and a missing one", async () => {
    const studio = await seedStudio();
    const input = (adoptEnvironmentId: string) => ({
      studioEnvironmentId: studio.id,
      name: "My Shop",
      adoptEnvironmentId,
    });
    expect(await code(ensure(input(studio.id)))).toBe("ADOPT_NOT_ALLOWED");
    expect(await code(ensure(input(await h.envs.seedStandalone(STRANGER))))).toBe("ADOPT_NOT_ALLOWED");
    expect(await code(ensure(input("env-missing")))).toBe("ADOPT_NOT_ALLOWED");
    const otherStudio = await seedStudio();
    expect(await code(ensure(input(otherStudio.id)))).toBe("ADOPT_NOT_ALLOWED");
    const github = await seedActiveApp(h);
    expect(await code(ensure(input(github.production_environment_id)))).toBe("ADOPT_NOT_ALLOWED");
    expect(await appCount()).toBe(1);
    expect(h.harbor.projects).toStrictEqual(["app-shop"]);
  });

  it("an adopted env is never swept", async () => {
    const studio = await seedStudio();
    const old = await h.envs.seedStandalone(OWNER);
    await ensure({ studioEnvironmentId: studio.id, name: "My Shop", adoptEnvironmentId: old });
    h.clock.now = new Date(h.clock.now.getTime() + 30 * DAY);
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(0);
    expect((await h.envs.getState(old))!.status).not.toBe("TERMINATING");
  });
});

describe("unlaunched Studio products (D8, F32)", () => {
  it("never-launched App is cleaned up after 14 days and a launched one never", async () => {
    const make = async (name: string) => {
      const s = await seedStudio();
      return ensure({ studioEnvironmentId: s.id, name });
    };
    const idle = await make("Idle");
    const launched = await make("Launched");
    const withDrive = await make("With Drive");
    const deployed = await make("Deployed");
    const github = await seedActiveApp(h);
    await h.db.updateTable("apps").set({ launched_at: h.clock.now.toISOString() }).where("id", "=", launched.id).execute();
    await h.db.updateTable("apps").set({ product_drive_id: "drive-1" }).where("id", "=", withDrive.id).execute();
    await deployApp(h.deps, owner, {
      appId: deployed.id, kind: "PRODUCTION", gitRef: "refs/heads/main", sha: "abcdef1234567",
      packages: [{ name: "@acme/shop", version: "0.1.0" }],
    });

    // Not yet 14 days: nothing.
    h.clock.now = new Date(h.clock.now.getTime() + 13 * DAY);
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(0);

    h.clock.now = new Date(h.clock.now.getTime() + 2 * DAY);
    const logged = (h.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(1);
    expect((await getApp(h.db, idle.id))!.status).toBe("DELETED");
    // The env is terminated, its document kept.
    const env = await h.envs.getState(idle.production_environment_id);
    expect(env?.status).toBe("TERMINATING");
    expect(h.envs.deleted).toStrictEqual([]);
    const lines = (h.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.slice(logged).map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("Idle".toLowerCase()) && l.includes("terminated"))).toBe(true);

    for (const kept of [launched, withDrive, deployed, github]) {
      expect((await getApp(h.db, kept.id))!.status).not.toBe("DELETED");
      expect((await h.envs.getState(kept.production_environment_id))!.status).not.toBe("TERMINATING");
    }
    // Once is enough.
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(0);
    // The Studio may make a new product afterwards.
    const again = await ensure({ studioEnvironmentId: idle.studio_environment_id!, name: "Idle" });
    expect(again.id).not.toBe(idle.id);
    expect(again.slug).toBe("idle-2");
  });

  it("a deployment that lands between selection and deletion keeps the App (any status but FAILED)", async () => {
    for (const status of ["PENDING", "DEPLOYING", "READY", "SUPERSEDED"] as const) {
      const s = await seedStudio();
      const app = await ensure({ studioEnvironmentId: s.id, name: `Racing ${status}` });
      // The sweep selected the row; then a launch inserts its deployment.
      const selected = (await getApp(h.db, app.id))!;
      await h.db
        .insertInto("app_deployments")
        .values({
          id: `dep-${status}`, app_id: app.id, environment_id: app.production_environment_id,
          kind: "PRODUCTION", pr_number: null, git_ref: "refs/heads/main", sha: "abcdef1234567",
          packages: "[]", image_tag: null, status, actor_did: null, actor_github: null, run_url: null,
          error: null, github_deployment_id: null, created_at: "t", updated_at: "t",
        })
        .execute();
      expect(await removeUnlaunchedStudioApp(h.deps, selected)).toBe(false);
      expect((await getApp(h.db, app.id))!.status).toBe("ACTIVE");
      expect((await h.envs.getState(app.production_environment_id))!.status).not.toBe("TERMINATING");
    }
    // A launch marker set after the selection protects too.
    const s = await seedStudio();
    const app = await ensure({ studioEnvironmentId: s.id, name: "Marked" });
    const selected = (await getApp(h.db, app.id))!;
    await h.db.updateTable("apps").set({ launched_at: "t" }).where("id", "=", app.id).execute();
    expect(await removeUnlaunchedStudioApp(h.deps, selected)).toBe(false);
  });

  it("the conditional deletion works in the namespace schema", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const ns = root.withSchema("vetra-apps");
      await up(ns);
      const s = await seedStudio();
      const app = await ensure({ studioEnvironmentId: s.id, name: "Namespaced" });
      const row = (await getApp(h.db, app.id))!;
      await ns.insertInto("apps").values(row).execute();
      await ns.insertInto("apps").values({ ...row, id: "other", slug: "other", studio_environment_id: "s2" }).execute();
      await ns
        .insertInto("app_deployments")
        .values({
          id: "d1", app_id: "other", environment_id: null, kind: "PRODUCTION", pr_number: null,
          git_ref: "refs/heads/main", sha: "abcdef1234567", packages: "[]", image_tag: null,
          status: "READY", actor_did: null, actor_github: null, run_url: null, error: null,
          github_deployment_id: null, created_at: "t", updated_at: "t",
        })
        .execute();
      const nsDeps = { ...h.deps, db: ns, docs: null };
      expect(await removeUnlaunchedStudioApp(nsDeps, row)).toBe(true);
      expect(await removeUnlaunchedStudioApp(nsDeps, { ...row, id: "other" })).toBe(false);
      const statusOf = async (id: string) =>
        (await ns.selectFrom("apps").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
      expect(await statusOf(row.id)).toBe("DELETED");
      expect(await statusOf("other")).toBe("ACTIVE");
    } finally {
      await root.destroy();
    }
  });

  it("a failed READY-less deployment does not count as launched; a FAILED one does not protect", async () => {
    const s = await seedStudio();
    const app = await ensure({ studioEnvironmentId: s.id, name: "Shop" });
    await deployApp(h.deps, owner, {
      appId: app.id, kind: "PRODUCTION", gitRef: "refs/heads/main", sha: "abcdef1234567", packages: [],
    });
    await h.db.updateTable("app_deployments").set({ status: "FAILED" }).where("app_id", "=", app.id).execute();
    h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(1);
  });
});

describe("Apps without a repository on the GitHub paths (F30)", () => {
  async function repoLess(): Promise<AppRow> {
    const s = await seedStudio();
    return ensure({ studioEnvironmentId: s.id, name: "My Shop" });
  }

  it("the deployment watcher and the GitHub feedback pass over it", async () => {
    const app = await repoLess();
    const d = await deployApp(h.deps, owner, {
      appId: app.id, kind: "PRODUCTION", gitRef: "refs/heads/main", sha: "abcdef1234567",
      packages: [{ name: "@acme/shop", version: "0.1.0" }],
    });
    expect(d.status).toBe("DEPLOYING");
    h.envs.setStatus(app.production_environment_id, "READY");
    expect(await runDeploymentWatcherOnce(h.deps)).toStrictEqual([d.id]);
    await reportDeploymentToGithub(h.deps, d.id);
    await reportPreviewRemovedToGithub(h.deps, app, { pr_number: 1 }, "test");
    expect(await runPreviewSweepOnce(h.deps)).toBe(0);
    expect(h.github.calls.createDeployment).toBeUndefined();
    expect(h.github.calls.upsertPrComment).toBeUndefined();
    expect(h.github.calls.getPullRequestState).toBeUndefined();
  });

  it("PR previews are refused without touching GitHub or making an env", async () => {
    const app = await repoLess();
    const envs = h.envs.docs.size;
    await h.db.updateTable("apps").set({ previews_enabled: true }).where("id", "=", app.id).execute();
    expect(await code(deployApp(h.deps, owner, {
      appId: app.id, kind: "PREVIEW", prNumber: 3, gitRef: "refs/pull/3/merge", sha: "abcdef1234567", packages: [],
    }))).toBe("PREVIEWS_DISABLED");
    expect(h.envs.docs.size).toBe(envs);
    expect(h.github.calls.getPullRequestState).toBeUndefined();
  });

  it("CI deploys are refused: no claim matches an App without a repository", async () => {
    const app = await repoLess();
    await h.db.updateTable("apps").set({ identity_did: "did:key:zDnaeAppIdentity" }).where("id", "=", app.id).execute();
    for (const c of [claim("refs/heads/main"), claim("refs/heads/main", { repositoryId: undefined })]) {
      expect(await code(deployAsCi(h.deps, c, {
        appId: app.id, kind: "PRODUCTION", gitRef: "refs/heads/main", sha: "abcdef1234567", packages: [],
      }))).toBe("FORBIDDEN");
    }
  });

  it("createStudioApp and the other GitHub-only paths refuse cleanly", async () => {
    const app = await repoLess();
    await connectGithubDeploy(h.deps, owner, "code");
    expect(await code(createStudioApp(h.deps, owner, {
      name: "My Shop", studioEnvironmentId: app.studio_environment_id!, installationId: INSTALLATION,
    }))).toBe("BAD_USER_INPUT");
    expect(h.github.calls.createRepoAsUser).toBeUndefined();
    expect(await code(openAppSetupPullRequest(h.deps, owner, app.id))).toBe("BAD_USER_INPUT");
    expect(await code(appRegistryCredentials(h.deps, owner, app.id))).toBe("BAD_USER_INPUT");
    // No CI identity to confirm: the App stays ACTIVE whatever Renown says.
    h.renown.delegation = null;
    expect((await confirmAppIdentity(h.deps, owner, app.id)).status).toBe("ACTIVE");
    // Deleting asks Renown for nothing.
    expect(await deleteApp(h.deps, owner, app.id, false)).toBe(true);
    expect(h.renown.deleted).toStrictEqual([]);
  });

  it("GraphQL maps it with a null repository; the header picks the agent path", async () => {
    const studio = await seedStudio();
    const r = createResolvers(h.deps);
    const ctx = (headers: Record<string, string>, appKey = AGENT_KEY) => ({
      user: { address: OWNER, chainId: 1, networkId: "eip155", appKey },
      headers,
    });
    const input = { studioEnvironmentId: studio.id, name: "My Shop" };
    const mapped = await r.Mutation.ensureStudioProduct(null, { input }, ctx({ [STUDIO_SECRET_HEADER]: studio.secret! }));
    expect(mapped).toMatchObject({ repository: null, productDriveId: null, launchedAt: null, identityDid: AGENT_KEY });
    expect(await mapped.productionUrls()).toMatchObject({ connect: "https://my-shop.vetra.io" });
    // An empty header is still the agent path.
    await expect(
      r.Mutation.ensureStudioProduct(null, { input }, ctx({ [STUDIO_SECRET_HEADER]: "" })),
    ).rejects.toMatchObject({ extensions: { code: "STUDIO_BINDING" } });
    // The query, for the agent and for the owner's browser.
    expect(
      await r.Query.studioProduct(null, { studioEnvironmentId: studio.id }, ctx({ [STUDIO_SECRET_HEADER]: studio.secret! })),
    ).toMatchObject({ id: mapped.id });
    expect(
      await r.Query.studioProduct(null, { studioEnvironmentId: studio.id }, ctx({}, "did:key:zDnaeOwnerBrowser")),
    ).toMatchObject({ id: mapped.id });
  });
});

describe("myApps", () => {
  it("lists Studio products without a repository only when asked", async () => {
    const studio = await seedStudio();
    const product = await ensure({ studioEnvironmentId: studio.id, name: "My Shop" });
    const github = await seedActiveApp(h);
    expect((await myApps(h.deps, owner)).map((a) => a.id)).toStrictEqual([github.id]);
    expect(
      (await myApps(h.deps, owner, null, { includeStudioProducts: true })).map((a) => a.id).sort(),
    ).toStrictEqual([github.id, product.id].sort());
  });
});

describe("studioProduct", () => {
  it("answers the agent and the owner; null for strangers and Studios without a product", async () => {
    const studio = await seedStudio();
    expect(await studioProductFor(h.deps, owner, studio.id, OWNER_AUTH)).toBeNull();
    const app = await ensure({ studioEnvironmentId: studio.id, name: "My Shop" });
    expect((await studioProductFor(h.deps, owner, studio.id, OWNER_AUTH))!.id).toBe(app.id);
    expect((await studioProductFor(h.deps, agent, studio.id, agentAuth(studio.secret)))!.id).toBe(app.id);
    expect(await studioProductFor(h.deps, stranger, studio.id, OWNER_AUTH)).toBeNull();
    expect(await code(studioProductFor(h.deps, agent, studio.id, agentAuth(null)))).toBe("STUDIO_BINDING");
  });
});
