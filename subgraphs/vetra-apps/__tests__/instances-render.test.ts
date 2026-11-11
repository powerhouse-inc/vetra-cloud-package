import { describe, expect, it } from "vitest";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { FakeEnvs } from "./harness.js";
import {
  imageTag,
  instanceCreateActions,
  instanceUpdateActions,
  type InstanceImage,
} from "../instances/render.js";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const image = (tag = imageTag("1.5.0-main.1", D1)): InstanceImage => ({
  repository: "cr.vetra.io/acme/shop",
  tag,
  phHost: "cli",
});
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    }),
    approveChanges({}),
  ]);
  return id;
}

describe("instanceCreateActions", () => {
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
    expect(s.fusion!.env).toEqual([
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
    ]);
  });
});

describe("instanceUpdateActions", () => {
  it("is empty when the environment already runs the image", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(instanceUpdateActions(s, image(), OWNER)).toEqual([]);
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
    expect(() => instanceUpdateActions(production, image(), OWNER)).toThrow(
      /"shop-main" is not an instance/,
    );
    expect(() =>
      instanceUpdateActions({ ...s, app: null }, image(), OWNER),
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
    expect(() => instanceUpdateActions(s, image(`@${D2}`), OWNER)).toThrow(
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
      }),
    ).toThrow(/version/);
  });
});
