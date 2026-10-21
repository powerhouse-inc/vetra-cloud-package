import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addPackage,
  approveChanges,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { Caller } from "../auth.js";
import { getApp, latestDeployment, type AppRow } from "../repo.js";
import { createResolvers } from "../resolvers.js";
import {
  attachStudioRepository,
  clearExternalChanges,
  connectGithubDeploy,
  ensureStudioProduct,
  launchStudioVersion,
  recordStudioMirror,
} from "../service.js";
import {
  hashLaunchSecret,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
} from "../studio-binding.js";
import { handleGithubWebhook } from "../webhook.js";
import {
  makeHarness,
  OWNER,
  owner,
  REPO_ID,
  seedActiveApp,
  type Harness,
} from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
const OTHER_AGENT_KEY = "did:key:zDnaeOtherStudioAgent";
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const otherAgent: Caller = { address: OWNER, chainId: 1, appKey: OTHER_AGENT_KEY, isAdmin: false };
const PERSONAL = "88";
const ZERO = "0".repeat(40);
const OURS = "1111111111111111111111111111111111111111";
const EARLIER = "2222222222222222222222222222222222222222";
const THEIRS = "3333333333333333333333333333333333333333";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.renown.delegation = { expiresAt: "2027-10-02T12:00:00.000Z" };
  h.github.installations.push({
    installationId: PERSONAL,
    appId: "1001",
    accountLogin: "frank",
    accountType: "User",
  });
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

interface Product {
  app: AppRow;
  secret: string;
}

/** A Studio product made by its agent, with a GitHub repository in the owner's account. */
async function seedProductOnGithub(by: Caller = agent, name = "My Shop"): Promise<Product> {
  const studioId = await h.envs.seedStandalone(OWNER);
  await h.envs.execute(studioId, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  const secret = randomBytes(32).toString("hex");
  await storeLaunchSecretHash(h.db, studioId, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
  const made = await ensureStudioProduct(
    h.deps,
    by,
    { studioEnvironmentId: studioId, name },
    { kind: "agent", secret },
  );
  h.envs.setStatus(made.production_environment_id, "READY");
  await connectGithubDeploy(h.deps, owner, "code");
  const app = await attachStudioRepository(h.deps, owner, {
    appId: made.id,
    installationId: PERSONAL,
  });
  return { app, secret };
}

async function launch(p: Product, versionNumber: number, sha: string) {
  return launchStudioVersion(
    h.deps,
    agent,
    {
      appId: p.app.id,
      versionNumber,
      sha,
      gitTag: `v${versionNumber}`,
      packages: [{ name: "@vetra-apps/my-shop", version: `0.${versionNumber}.0` }],
    },
    p.secret,
  );
}

function pushBody(
  app: Pick<AppRow, "repository_id" | "installation_id">,
  over: { ref?: string; after?: string; deleted?: boolean; commits?: string[] } = {},
): string {
  const after = over.after ?? THEIRS;
  const commits = over.commits ?? (after === ZERO ? [] : [after]);
  return JSON.stringify({
    ref: over.ref ?? "refs/heads/main",
    before: OURS,
    after,
    created: false,
    deleted: over.deleted ?? after === ZERO,
    forced: false,
    commits: commits.map((id) => ({ id, message: "edit on GitHub" })),
    head_commit: commits.length ? { id: after } : null,
    repository: { id: Number(app.repository_id), full_name: "frank/my-shop" },
    installation: { id: Number(app.installation_id) },
    pusher: { name: "someone" },
  });
}

function push(body: string, secret = "whsec") {
  return handleGithubWebhook(h.deps, {
    rawBody: Buffer.from(body),
    signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    event: "push",
  });
}

const externalSha = async (id: string) => (await getApp(h.db, id))?.external_changes_sha ?? null;

describe("push webhook (D15, edits made on GitHub)", () => {
  it("own mirror push is ignored", async () => {
    const p = await seedProductOnGithub();
    // An earlier mirror on version 1, then version 2's mirror.
    await launch(p, 1, EARLIER);
    expect(await recordStudioMirror(h.deps, agent, p.app.id, EARLIER, p.secret)).toBe(true);
    await launch(p, 2, OURS);
    expect(await recordStudioMirror(h.deps, agent, p.app.id, OURS.toUpperCase(), p.secret)).toBe(
      true,
    );
    // Stored on the latest PRODUCTION deployment.
    const latest = await latestDeployment(h.db, p.app.id);
    expect(latest?.mirror_sha).toBe(OURS);

    // The Studio's push carries several commits; its head is the recorded sha.
    const res = await push(pushBody(p.app, { after: OURS, commits: [EARLIER, OURS] }));
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ flaggedApps: 0 });
    expect(await externalSha(p.app.id)).toBeNull();

    // A late delivery of the earlier mirror push (recorded on another deployment) too.
    await push(pushBody(p.app, { after: EARLIER }));
    expect(await externalSha(p.app.id)).toBeNull();
  });

  it("own mirror push before the first launch is ignored too (no deployment yet)", async () => {
    const p = await seedProductOnGithub();
    expect(await latestDeployment(h.db, p.app.id)).toBeNull();
    expect(await recordStudioMirror(h.deps, agent, p.app.id, OURS, p.secret)).toBe(true);
    await push(pushBody(p.app, { after: OURS }));
    expect(await externalSha(p.app.id)).toBeNull();
  });

  it("push to main by someone else is flagged", async () => {
    const p = await seedProductOnGithub();
    await launch(p, 1, OURS);
    await recordStudioMirror(h.deps, agent, p.app.id, OURS, p.secret);

    // A recorded sha among the commits does not hide an outside head.
    const res = await push(pushBody(p.app, { after: THEIRS, commits: [OURS, THEIRS] }));
    expect(res).toStrictEqual({ status: 200, body: { flaggedApps: 1 } });
    expect(await externalSha(p.app.id)).toBe(THEIRS);

    // The agent reads it via studioProduct.
    const resolvers = createResolvers(h.deps);
    const agentCtx = {
      user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: AGENT_KEY },
      headers: { [STUDIO_SECRET_HEADER]: p.secret },
    };
    const read = (await (resolvers.Query.studioProduct as (...a: unknown[]) => Promise<unknown>)(
      null,
      { studioEnvironmentId: p.app.studio_environment_id },
      agentCtx,
    )) as { externalChangesSha: string | null };
    expect(read.externalChangesSha).toBe(THEIRS);

    // A later outside push moves it to the newest commit.
    const NEWER = "4444444444444444444444444444444444444444";
    await push(pushBody(p.app, { after: NEWER }));
    expect(await externalSha(p.app.id)).toBe(NEWER);

    // Brought in: the agent clears it (over GraphQL).
    expect(
      await (resolvers.Mutation.clearExternalChanges as (...a: unknown[]) => Promise<boolean>)(
        null,
        { appId: p.app.id },
        agentCtx,
      ),
    ).toBe(true);
    expect(await externalSha(p.app.id)).toBeNull();
  });

  it("push to another branch is ignored", async () => {
    const p = await seedProductOnGithub();
    for (const ref of ["refs/heads/feature", "refs/tags/v1", "refs/heads/main-old"]) {
      expect((await push(pushBody(p.app, { ref }))).body).toStrictEqual({ flaggedApps: 0 });
    }
    // Deleting the branch is not a change to flag.
    await push(pushBody(p.app, { after: ZERO }));
    expect(await externalSha(p.app.id)).toBeNull();
  });

  it("ignores Apps deployed by their own CI and unsigned deliveries", async () => {
    const ci = await seedActiveApp(h);
    expect(ci.repository_id).toBe(REPO_ID);
    await push(pushBody(ci));
    expect(await externalSha(ci.id)).toBeNull();

    const p = await seedProductOnGithub();
    expect((await push(pushBody(p.app), "wrong")).status).toBe(401);
    // Another installation's delivery for the same repository id is not ours.
    await push(pushBody({ ...p.app, installation_id: "999" }));
    expect(await externalSha(p.app.id)).toBeNull();
  });

  it("recordStudioMirror and clearExternalChanges take only the product's own agent", async () => {
    const p = await seedProductOnGithub();
    const other = await seedProductOnGithub(otherAgent, "Other Shop");
    for (const call of [
      () => recordStudioMirror(h.deps, otherAgent, p.app.id, OURS, other.secret),
      () => recordStudioMirror(h.deps, agent, p.app.id, OURS, other.secret),
      () => recordStudioMirror(h.deps, owner, p.app.id, OURS, null),
      () => clearExternalChanges(h.deps, otherAgent, p.app.id, other.secret),
      () => clearExternalChanges(h.deps, owner, p.app.id, null),
    ]) {
      expect(await code(call())).toBe("STUDIO_BINDING");
    }
    for (const sha of ["", "main", "xyz1234", "1".repeat(65)]) {
      expect(await code(recordStudioMirror(h.deps, agent, p.app.id, sha, p.secret))).toBe(
        "BAD_USER_INPUT",
      );
    }
    // Nothing recorded by the refused calls: the push is flagged.
    await push(pushBody(p.app, { after: OURS }));
    expect(await externalSha(p.app.id)).toBe(OURS);
    expect(await clearExternalChanges(h.deps, agent, p.app.id, p.secret)).toBe(true);
    expect(await externalSha(p.app.id)).toBeNull();
  });
});
