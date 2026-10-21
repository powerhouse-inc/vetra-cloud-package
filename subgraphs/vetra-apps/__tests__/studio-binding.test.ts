import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  addPackage,
  approveChanges,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { up as upSecrets } from "../../vetra-cloud-secrets/db/migrations.js";
import type { SecretsDB } from "../../vetra-cloud-secrets/db/schema.js";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  WORKFLOWS_MASTER_KEY,
  type SecretsService,
} from "../../vetra-cloud-secrets/services/secrets-service.js";
import type { Caller } from "../auth.js";
import { getApp, type AppRow } from "../repo.js";
import {
  hashLaunchSecret,
  presentedStudioSecret,
  rotateStudioLaunchSecret,
  STUDIO_BINDING_MESSAGE,
  STUDIO_LAUNCH_SECRET_KEY,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
  verifyStudioBinding,
  verifyStudioSecret,
} from "../studio-binding.js";
import {
  admin,
  APP_DID,
  MEMBER,
  makeHarness,
  ORG,
  OWNER,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
/** The Studio agent: its own did:key, acting for the owner under a delegation. */
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const FUTURE = "2027-10-02T12:00:00.000Z";
const PAST = "2026-10-01T12:00:00.000Z";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.renown.delegation = { expiresAt: FUTURE };
});
afterEach(async () => {
  await h.close();
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

/** A claimed Studio of `address` with its launch secret recorded; returns its id and secret. */
async function seedStudio(address = OWNER) {
  const id = await h.envs.seedStandalone(address);
  await h.envs.execute(id, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  const secret = randomBytes(32).toString("hex");
  await storeLaunchSecretHash(h.db, id, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
  return { id, secret };
}

/** The seeded App, bound to `studioId`. */
async function seedStudioApp(studioId: string): Promise<AppRow> {
  const app = await seedActiveApp(h);
  await h.db
    .updateTable("apps")
    .set({ studio_environment_id: studioId })
    .where("id", "=", app.id)
    .execute();
  return (await getApp(h.db, app.id))!;
}

describe("verifyStudioBinding", () => {
  it("passes for the Studio's own agent with its own secret and a current delegation", async () => {
    const studio = await seedStudio();
    const app = await seedStudioApp(studio.id);
    await expect(verifyStudioBinding(h.deps, agent, studio.secret, app)).resolves.toBeUndefined();
    await expect(verifyStudioSecret(h.deps, agent, studio.secret, studio.id)).resolves.toBeUndefined();
    // A delegation without an expiry is current.
    h.renown.delegation = { expiresAt: null };
    await expect(verifyStudioBinding(h.deps, agent, studio.secret, app)).resolves.toBeUndefined();
  });

  it("binding refuses another Studio's secret", async () => {
    const mine = await seedStudio();
    const other = await seedStudio();
    const app = await seedStudioApp(mine.id);
    const err = await verifyStudioBinding(h.deps, agent, other.secret, app).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: STUDIO_BINDING_MESSAGE,
      extensions: { code: "STUDIO_BINDING" },
    });
    // The other Studio's secret opens only the other Studio.
    expect(await codeOf(verifyStudioSecret(h.deps, agent, other.secret, other.id))).toBe("OK");
    // No secret, a made-up one, or a hash instead of the secret: refused alike.
    for (const presented of [null, "", randomBytes(32).toString("hex"), hashLaunchSecret(mine.secret)]) {
      expect(await codeOf(verifyStudioBinding(h.deps, agent, presented, app))).toBe("STUDIO_BINDING");
    }
  });

  it("refuses an App that is not bound to a Studio, a deleted App and a Studio without a secret", async () => {
    const studio = await seedStudio();
    const app = await seedStudioApp(studio.id);
    const unbound = { ...app, studio_environment_id: null };
    expect(await codeOf(verifyStudioBinding(h.deps, agent, studio.secret, unbound))).toBe("STUDIO_BINDING");
    expect(
      await codeOf(verifyStudioBinding(h.deps, agent, studio.secret, { ...app, status: "DELETED" })),
    ).toBe("STUDIO_BINDING");
    await h.db.deleteFrom("studio_launch_secrets").execute();
    expect(await codeOf(verifyStudioBinding(h.deps, agent, studio.secret, app))).toBe("STUDIO_BINDING");
  });

  it("refuses a caller who does not own the Studio, and a deleted Studio", async () => {
    const studio = await seedStudio();
    const app = await seedStudioApp(studio.id);
    const otherAgent: Caller = { ...stranger, appKey: AGENT_KEY };
    expect(await codeOf(verifyStudioBinding(h.deps, otherAgent, studio.secret, app))).toBe("STUDIO_BINDING");
    // Admin rights do not stand in for the binding.
    const adminAgent: Caller = { ...admin, appKey: AGENT_KEY };
    expect(await codeOf(verifyStudioSecret(h.deps, adminAgent, studio.secret, studio.id))).toBe(
      "STUDIO_BINDING",
    );
    await h.envs.delete(studio.id);
    expect(await codeOf(verifyStudioBinding(h.deps, agent, studio.secret, app))).toBe("STUDIO_BINDING");
  });

  it("binding refuses an expired delegation", async () => {
    const studio = await seedStudio();
    const app = await seedStudioApp(studio.id);
    h.renown.delegation = { expiresAt: PAST };
    expect(await codeOf(verifyStudioBinding(h.deps, agent, studio.secret, app))).toBe("DELEGATION_EXPIRED");
    // Renown no longer has a valid one (expired or revoked since the session began).
    h.renown.delegation = null;
    expect(await codeOf(verifyStudioSecret(h.deps, agent, studio.secret, studio.id))).toBe(
      "DELEGATION_EXPIRED",
    );
  });

  it("asks Renown for the caller's delegation to the agent key on every call", async () => {
    const studio = await seedStudio();
    const spy = vi.spyOn(h.renown, "getDelegation");
    await verifyStudioSecret(h.deps, agent, studio.secret, studio.id);
    await verifyStudioSecret(h.deps, agent, studio.secret, studio.id);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ address: OWNER, chainId: 1, did: AGENT_KEY });
  });

  it("refuses with DELEGATION_MISSING when the caller is not an agent key", async () => {
    const studio = await seedStudio();
    const app = await seedStudioApp(studio.id);
    const noKey: Caller = { ...agent, appKey: null };
    const err = await verifyStudioBinding(h.deps, noKey, studio.secret, app).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: "Your Studio needs your OK to publish.",
      extensions: { code: "DELEGATION_MISSING" },
    });
  });

  it("binding refuses a caller who no longer operates an org App", async () => {
    // The member's own Studio, whose App was moved to the organisation.
    const studio = await seedStudio(MEMBER);
    const app = await seedStudioApp(studio.id);
    await h.db
      .updateTable("apps")
      .set({ owner_org_id: ORG, owner_address: MEMBER })
      .where("id", "=", app.id)
      .execute();
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    const orgApp = (await getApp(h.db, app.id))!;
    const memberAgent: Caller = { address: MEMBER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };

    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    expect(await codeOf(verifyStudioBinding(h.deps, memberAgent, studio.secret, orgApp))).toBe("OK");

    // Demoted to a plain member: no longer operates the App.
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await codeOf(verifyStudioBinding(h.deps, memberAgent, studio.secret, orgApp))).toBe(
      "STUDIO_BINDING",
    );
    // Gone from the organisation.
    h.orgs.members.clear();
    expect(await codeOf(verifyStudioBinding(h.deps, memberAgent, studio.secret, orgApp))).toBe(
      "STUDIO_BINDING",
    );
  });

  it("answers SERVICE_NOT_CONFIGURED without Renown", async () => {
    const studio = await seedStudio();
    h.deps.renown = null;
    expect(await codeOf(verifyStudioSecret(h.deps, agent, studio.secret, studio.id))).toBe(
      "SERVICE_NOT_CONFIGURED",
    );
  });

  it("reads the secret from the x-vetra-studio-secret header", () => {
    const secret = randomBytes(32).toString("hex");
    expect(STUDIO_SECRET_HEADER).toBe("x-vetra-studio-secret");
    expect(presentedStudioSecret({ headers: { [STUDIO_SECRET_HEADER]: secret } })).toBe(secret);
    expect(presentedStudioSecret({ headers: { [STUDIO_SECRET_HEADER]: [` ${secret} `] } })).toBe(secret);
    expect(presentedStudioSecret({ headers: { [STUDIO_SECRET_HEADER]: "  " } })).toBeNull();
    expect(presentedStudioSecret({ headers: {} })).toBeNull();
    expect(presentedStudioSecret({})).toBeNull();
  });
});

describe("rotateStudioLaunchSecret", () => {
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
    secretsDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(new PGlite()) });
    await upSecrets(secretsDb);
    secrets = createSecretsService({ db: secretsDb, transit });
    h.deps.studioSecrets = secrets;
  });
  afterEach(async () => {
    await secretsDb.destroy();
  });

  const tenantOf = async (envId: string) =>
    getTenantId((await h.envs.getState(envId))!.genericSubdomain!, envId);
  const snapshot = async (tenantId: string) => ({
    envVars: await secretsDb
      .selectFrom("tenant_env_vars")
      .select(["key", "value"])
      .where("tenantId", "=", tenantId)
      .orderBy("key")
      .execute(),
    secrets: await secretsDb
      .selectFrom("tenant_secrets")
      .select(["key", "ciphertext", "updatedAt"])
      .where("tenantId", "=", tenantId)
      .orderBy("key")
      .execute(),
  });
  const launchSecretOf = async (tenantId: string) => {
    const row = await secretsDb
      .selectFrom("tenant_secrets")
      .select("ciphertext")
      .where("tenantId", "=", tenantId)
      .where("key", "=", STUDIO_LAUNCH_SECRET_KEY)
      .executeTakeFirst();
    return row?.ciphertext?.replace(`vault:v1:${tenantId}:`, "");
  };

  it("rotate writes one key and touches no other", async () => {
    const studio = await seedStudio();
    const tenantId = await tenantOf(studio.id);
    await secrets.setSecret(tenantId, "OPENROUTER_API_KEY", randomBytes(16).toString("hex"));
    await secrets.setSecret(tenantId, "VETRA_SESSION_EXPORT_SECRET", randomBytes(32).toString("hex"));
    await secrets.setEnvVar(tenantId, "ADMINS", OWNER);
    await secrets.setEnvVar(tenantId, "VETRA_MODEL", "anthropic/claude-sonnet-4.6");
    await secrets.ensureSecret(tenantId, WORKFLOWS_MASTER_KEY, () => randomBytes(32).toString("hex"));
    const before = await snapshot(tenantId);
    const replace = vi.spyOn(secrets, "replaceTenantConfig");
    const ensure = vi.spyOn(secrets, "ensureSecret");
    const set = vi.spyOn(secrets, "setManagedSecret");

    // Backfill: no launch secret yet → ensureSecret.
    expect(await rotateStudioLaunchSecret(h.deps, admin, studio.id)).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0].slice(0, 2)).toStrictEqual([tenantId, STUDIO_LAUNCH_SECRET_KEY]);
    expect(set).not.toHaveBeenCalled();
    const first = await launchSecretOf(tenantId);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const after = await snapshot(tenantId);
    expect(after.envVars).toStrictEqual(before.envVars);
    expect(after.secrets.filter((s) => s.key !== STUDIO_LAUNCH_SECRET_KEY)).toStrictEqual(before.secrets);

    // Rotation: present → the single-key set, nothing else.
    expect(await rotateStudioLaunchSecret(h.deps, admin, studio.id)).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0].slice(0, 2)).toStrictEqual([tenantId, STUDIO_LAUNCH_SECRET_KEY]);
    const second = await launchSecretOf(tenantId);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    const again = await snapshot(tenantId);
    expect(again.envVars).toStrictEqual(before.envVars);
    expect(again.secrets.filter((s) => s.key !== STUDIO_LAUNCH_SECRET_KEY)).toStrictEqual(before.secrets);
    expect(replace).not.toHaveBeenCalled();

    // Only the hash is stored; the new secret verifies, the old ones no longer do.
    const row = await h.db
      .selectFrom("studio_launch_secrets")
      .selectAll()
      .where("environment_id", "=", studio.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_hash).toBe(createHash("sha256").update(second!).digest("hex"));
    expect(await codeOf(verifyStudioSecret(h.deps, agent, second!, studio.id))).toBe("OK");
    for (const old of [first!, studio.secret]) {
      expect(await codeOf(verifyStudioSecret(h.deps, agent, old, studio.id))).toBe("STUDIO_BINDING");
    }
    // Never logged.
    for (const fn of Object.values(h.deps.logger) as ReturnType<typeof vi.fn>[]) {
      for (const call of fn.mock.calls) {
        expect(String(call[0])).not.toContain(second!);
        expect(String(call[0])).not.toContain(first!);
      }
    }
  });

  it("is admin-only", async () => {
    const studio = await seedStudio();
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, owner, studio.id))).toBe("FORBIDDEN");
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, agent, studio.id))).toBe("FORBIDDEN");
  });

  it("refuses what is not a claimed Studio, and answers SERVICE_NOT_CONFIGURED without OpenBao", async () => {
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, admin, "env-missing"))).toBe("NOT_FOUND");
    const plain = await h.envs.seedStandalone();
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, admin, plain))).toBe("BAD_USER_INPUT");
    // A warm (unclaimed) Studio gets its secret at claim.
    const warm = await h.envs.create();
    await h.envs.execute(warm, [
      addPackage({ packageName: "vetra", version: "0.0.1-dev.27", registry: "https://registry.dev.vetra.io" }),
    ]);
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, admin, warm))).toBe("BAD_USER_INPUT");
    h.deps.studioSecrets = null;
    const studio = await seedStudio();
    expect(await codeOf(rotateStudioLaunchSecret(h.deps, admin, studio.id))).toBe("SERVICE_NOT_CONFIGURED");
  });
});
