import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReactorEnvGateway } from "../envs.js";
import {
  deleteApp,
  deletePreview,
  deployApp,
  type DeployAppInput,
} from "../service.js";
import {
  getApp,
  getDeployment,
  getPreview,
  listPreviews,
  type AppRow,
} from "../repo.js";
import { runDeploymentWatcherOnce, runPreviewSweepOnce } from "../watcher.js";
import { FakeReactorClient } from "./fake-reactor.js";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";

/** Harness whose env gateway runs over a reactor-like client (real gateway code). */
let h: Harness;
let client: FakeReactorClient;
let app: AppRow;
beforeEach(async () => {
  h = await makeHarness();
  client = new FakeReactorClient();
  h.deps.envs = createReactorEnvGateway(client as never);
  app = await seedActiveApp(h);
});
afterEach(async () => {
  await h.close();
});

const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const prod = (): DeployAppInput => ({
  appId: app.id,
  kind: "PRODUCTION",
  gitRef: "refs/heads/main",
  sha: SHA,
  packages: [{ name: "@acme/shop", version: "1.0.0" }],
});
const preview = (n: number): DeployAppInput => ({
  ...prod(),
  kind: "PREVIEW",
  prNumber: n,
  gitRef: `refs/pull/${n}/merge`,
});
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string }; message?: string }) =>
      e.extensions?.code ?? String(e.message),
  );

describe("I3: reducer rejections fail the deployment immediately, before APPROVE", () => {
  it("marks FAILED with the reducer message and never appends APPROVE_CHANGES", async () => {
    const envId = app.production_environment_id;
    const approvesBefore = client
      .opTypes(envId)
      .filter((t) => t === "APPROVE_CHANGES").length;
    client.rejectTypes.add("ADD_PACKAGE");
    const d = await deployApp(h.deps, owner, prod());
    expect(d.status).toBe("FAILED");
    expect(d.error).toMatch(/ADD_PACKAGE is not allowed now/);
    expect(
      client.opTypes(envId).filter((t) => t === "APPROVE_CHANGES"),
    ).toHaveLength(approvesBefore);
  });
});

describe("I4: transient reactor errors never orphan envs or drop rows", () => {
  it("deploy to an existing preview: transient error keeps the row and creates no 2nd env", async () => {
    const d1 = await deployApp(h.deps, owner, preview(3));
    const docsBefore = client.docs.size;
    client.transient.add(d1.environment_id!);
    expect(await code(deployApp(h.deps, owner, preview(3)))).not.toBe("OK");
    expect((await getPreview(h.db, app.id, 3))?.environment_id).toBe(
      d1.environment_id,
    );
    expect(client.docs.size).toBe(docsBefore);
  });

  it("deploy to a preview whose env is definitely gone recreates it", async () => {
    const d1 = await deployApp(h.deps, owner, preview(3));
    await client.deleteDocument(d1.environment_id!);
    const d2 = await deployApp(h.deps, owner, preview(3));
    expect(d2.environment_id).not.toBe(d1.environment_id);
  });

  it("deletePreview keeps the row on a transient error, drops it on not-found", async () => {
    const d = await deployApp(h.deps, owner, preview(4));
    const row = (await getPreview(h.db, app.id, 4))!;
    client.transient.add(d.environment_id!);
    expect(await code(deletePreview(h.deps, app, row, "test"))).not.toBe("OK");
    expect(await getPreview(h.db, app.id, 4)).not.toBeNull();
    client.transient.delete(d.environment_id!);
    await client.deleteDocument(d.environment_id!);
    await deletePreview(h.deps, app, row, "test");
    expect(await getPreview(h.db, app.id, 4)).toBeNull();
  });

  it("the sweeper keeps a preview row whose env read fails transiently", async () => {
    const d = await deployApp(h.deps, owner, preview(5));
    client.transient.add(d.environment_id!);
    h.clock.now = new Date(h.clock.now.getTime() + 30 * 86_400_000);
    expect(await runPreviewSweepOnce(h.deps)).toBe(0);
    expect(await listPreviews(h.db, app.id)).toHaveLength(1);
  });

  it("the watcher leaves DEPLOYING alone on a transient error, FAILs on not-found", async () => {
    const d = await deployApp(h.deps, owner, preview(6));
    expect(d.status).toBe("DEPLOYING");
    client.transient.add(d.environment_id!);
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, d.id))?.status).toBe("DEPLOYING");
    client.transient.delete(d.environment_id!);
    await client.deleteDocument(d.environment_id!);
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, d.id))?.status).toBe("FAILED");
  });

  it("deleteApp: a failing preview delete keeps the App (status unchanged) and errors", async () => {
    const d = await deployApp(h.deps, owner, preview(7));
    client.transient.add(d.environment_id!);
    expect(await code(deleteApp(h.deps, owner, app.id, false))).not.toBe("OK");
    expect((await getApp(h.db, app.id))?.status).toBe("ACTIVE");
    expect(await getPreview(h.db, app.id, 7)).not.toBeNull();
  });
});
