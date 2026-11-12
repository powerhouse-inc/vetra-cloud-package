import { describe, expect, it } from "vitest";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { FakeEnvs } from "./harness.js";
import {
  declaredSecretNames,
  declaresVetraSecrets,
  fusionEnv,
  imageTag,
  instanceCreateActions,
  instanceUpdateActions,
  settingsRevisionOf,
  type InstanceImage,
  type InstanceSettingsEnv,
} from "../instances/render.js";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const image = (tag = imageTag("1.5.0-main.1", D1)): InstanceImage => ({
  repository: "cr.vetra.io/acme/shop",
  tag,
  phHost: "cli",
});
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const S: InstanceSettingsEnv = {
  revision: "0123456789abcdef",
  plain: [{ name: "RELAY", value: "https://relay" }],
  secretNames: ["API_TOKEN"],
};

async function created(envs: FakeEnvs) {
  const id = await envs.create();
  await envs.execute(id, [
    ...instanceCreateActions({
      label: "Shop · main",
      host: "shop-main",
      baseDomain: "vetra.io",
      registry: "https://registry.dev.vetra.io",
      owner: OWNER,
      ownerOrgId: null,
      appId: "app-1",
      gitRef: "refs/heads/main",
      imageProject: "acme",
      image: image(),
      admins: OWNER,
      settings: S,
      start: true,
    }),
    approveChanges({}),
  ]);
  return id;
}

describe("instanceCreateActions", () => {
  it("links a preview instance to its PR", async () => {
    const envs = new FakeEnvs();
    const id = await envs.create();
    await envs.execute(id, [
      ...instanceCreateActions({
        label: "Shop · pr-12",
        host: "shop-pr-12-abc123",
        baseDomain: "vetra.io",
        registry: "https://registry.dev.vetra.io",
        owner: OWNER,
        ownerOrgId: null,
        appId: "app-1",
        gitRef: "refs/pull/12/head",
        prNumber: 12,
        imageProject: "acme",
        image: image(),
        admins: OWNER,
        settings: S,
        start: true,
      }),
      approveChanges({}),
    ]);
    expect((await envs.getState(id))!.app).toMatchObject({
      appId: "app-1",
      role: "PREVIEW",
      prNumber: 12,
      gitRef: "refs/pull/12/head",
    });
  });
  it("makes a host-image environment linked to the app, pinned by digest", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(s.status).toBe("CHANGES_APPROVED");
    expect(s.genericSubdomain).toBe("shop-main");
    expect(s.owner).toBe(OWNER);
    expect(s.app).toMatchObject({
      appId: "app-1",
      role: "PREVIEW",
      prNumber: null,
      gitRef: "refs/heads/main",
    });
    expect(s.apexService).toBe("FUSION");
    expect(s.services.filter((x) => x.enabled).map((x) => x.type)).toEqual([
      "FUSION",
    ]);
    expect(s.services[0].version).toBe(`1.5.0-main.1@${D1}`);
    expect(s.fusion).toMatchObject({
      image: "cr.vetra.io/acme/shop",
      autoUpdate: false,
    });
    expect(s.fusion!.env).toEqual(fusionEnv(image(), OWNER, S));
  });
});

describe("instanceUpdateActions", () => {
  it("is empty when the environment already runs the image", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(instanceUpdateActions(s, image(), OWNER, S)).toEqual([]);
  });

  it("moves the version only, then needs an approval", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "READY");
    const next = image(imageTag("1.5.0-main.2", D2));
    const actions = instanceUpdateActions(
      (await envs.getState(id))!,
      next,
      OWNER,
      S,
    );
    expect(actions.map((a) => a.type)).toEqual(["SET_SERVICE_VERSION"]);
    const after = await envs.execute(id, actions);
    expect(after.status).toBe("CHANGES_PENDING");
    expect(after.services[0].version).toBe(`1.5.0-main.2@${D2}`);
  });

  it("wakes a stopped environment before changing it", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "STOPPED");
    const actions = instanceUpdateActions(
      (await envs.getState(id))!,
      image(imageTag("1.5.0-main.2", D2)),
      OWNER,
      S,
    );
    expect(actions.map((a) => a.type)).toEqual([
      "WAKE_ENVIRONMENT",
      "SET_SERVICE_VERSION",
    ]);
    expect((await envs.execute(id, actions)).status).toBe("CHANGES_PENDING");
  });

  it("rewrites the FUSION config when the repository or ADMINS changed", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "READY");
    const moved = { ...image(), repository: "cr.vetra.io/new-org/shop" };
    expect(
      instanceUpdateActions(
        (await envs.getState(id))!,
        moved,
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        S,
      ).map((a) => a.type),
    ).toEqual(["SET_FUSION_CONFIG"]);
  });
});

describe("instanceUpdateActions refuses what is not an instance", () => {
  it("throws on a licensed environment (managedBy set), naming it", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    const licensed = {
      ...s,
      managedBy: {
        appId: "sektar",
        rootLicenseId: "lic-1",
        services: ["FUSION" as const],
        templateId: "t-1",
      },
    };
    expect(() =>
      instanceUpdateActions(
        licensed,
        image(imageTag("1.5.0-main.2", D2)),
        OWNER,
        S,
      ),
    ).toThrow(/"shop-main" is licensed/);
  });

  it("throws on an environment that is not an app PREVIEW", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    const production = {
      ...s,
      app: { ...s.app!, role: "PRODUCTION" as const },
    };
    expect(() => instanceUpdateActions(production, image(), OWNER, S)).toThrow(
      /"shop-main" is not an instance/,
    );
    expect(() =>
      instanceUpdateActions({ ...s, app: null }, image(), OWNER, S),
    ).toThrow(/not an instance/);
  });

  it.each(["TERMINATING", "DESTROYED", "ARCHIVED"] as const)(
    "does nothing to a %s environment",
    async (status) => {
      const envs = new FakeEnvs();
      const s = (await envs.getState(await created(envs)))!;
      expect(
        instanceUpdateActions(
          { ...s, status },
          image(imageTag("1.5.0-main.2", D2)),
          OWNER,
          S,
        ),
      ).toEqual([]);
    },
  );
});

describe("empty versions are refused", () => {
  it("imageTag throws on an empty version", () => {
    expect(() => imageTag("", D1)).toThrow(/version/);
  });

  it("create and update throw on a tag without a version", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(() => instanceUpdateActions(s, image(`@${D2}`), OWNER, S)).toThrow(
      /version/,
    );
    expect(() =>
      instanceCreateActions({
        label: "x",
        host: "x",
        baseDomain: "vetra.io",
        registry: "r",
        owner: OWNER,
        ownerOrgId: null,
        appId: "app-1",
        gitRef: "refs/heads/main",
        imageProject: "acme",
        image: image(`@${D1}`),
        admins: OWNER,
        settings: S,
        start: true,
      }),
    ).toThrow(/version/);
  });
});

describe("settings in the FUSION env", () => {
  it("declares Vetra's generated secrets and the publisher's, plain settings and the revision", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    const env = (await envs.getState(id))!.fusion!.env;
    expect(env).toEqual([
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
      { name: "RELAY", value: "https://relay", isSecret: false },
      { name: "VETRA_SETTINGS_REVISION", value: S.revision, isSecret: false },
      { name: "PH_WORKFLOWS_SECRETS_MASTER_KEY", value: null, isSecret: true },
      { name: "PH_ATTACHMENT_URL_SIGNING_SECRET", value: null, isSecret: true },
      { name: "API_TOKEN", value: null, isSecret: true },
    ]);
    const state = (await envs.getState(id))!;
    expect(declaresVetraSecrets(state)).toBe(true);
    expect(declaredSecretNames(state)).toEqual([
      "PH_WORKFLOWS_SECRETS_MASTER_KEY",
      "PH_ATTACHMENT_URL_SIGNING_SECRET",
      "API_TOKEN",
    ]);
    expect(settingsRevisionOf(state)).toBe(S.revision);
  });

  it("a new revision changes only the env, not the version", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    const state = (await envs.getState(id))!;
    const next = { ...S, revision: "fedcba9876543210", secretNames: [] };
    const types = instanceUpdateActions(state, image(), OWNER, next).map(
      (a) => a.type,
    );
    expect(types).toEqual(["SET_FUSION_CONFIG"]);
  });

  it("creates without a version when not started, and starts later", async () => {
    const envs = new FakeEnvs();
    const id = await envs.create();
    await envs.execute(id, [
      ...instanceCreateActions({
        label: "Shop · main",
        host: "shop-main",
        baseDomain: "vetra.io",
        registry: "https://registry.dev.vetra.io",
        owner: OWNER,
        ownerOrgId: null,
        appId: "app-1",
        gitRef: "refs/heads/main",
        imageProject: "acme",
        image: image(),
        admins: OWNER,
        settings: S,
        start: false,
      }),
      approveChanges({}),
    ]);
    const state = (await envs.getState(id))!;
    expect(
      state.services.find((s) => s.type === "FUSION")!.version ?? null,
    ).toBeNull();
    expect(instanceUpdateActions(state, image(), OWNER, S, false)).toEqual([]);
    expect(
      instanceUpdateActions(state, image(), OWNER, S, true).map((a) => a.type),
    ).toEqual(["SET_SERVICE_VERSION"]);
  });

  it("an instance from before slice 4 declares no Vetra secrets", () => {
    const legacy = {
      fusion: { env: [{ name: "PH_HOST", value: "cli", isSecret: false }] },
    } as never;
    expect(declaresVetraSecrets(legacy)).toBe(false);
  });
});
