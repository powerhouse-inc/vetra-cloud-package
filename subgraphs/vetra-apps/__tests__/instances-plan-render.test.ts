import { describe, expect, it } from "vitest";
import { FakeEnvs } from "./harness.js";
import {
  instanceCreateActions,
  instanceUpdateActions,
} from "../instances/render.js";

const settings = { revision: "r1", plain: [], secretNames: [] };
const image = {
  repository: "cr.vetra.io/acme/shop",
  tag: "1.4.0@sha256:" + "b".repeat(64),
  phHost: "cli",
};
const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";

async function planDoc(envs: FakeEnvs) {
  const id = await envs.create();
  await envs.execute(
    id,
    instanceCreateActions({
      label: "Shop · own-1",
      host: "calm-bat-12345678",
      baseDomain: "vetra.io",
      registry: "https://registry.vetra.io",
      owner: SERVICE,
      ownerOrgId: null,
      appId: "app-1",
      gitRef: null,
      imageProject: "acme",
      image,
      admins: HOLDER,
      settings,
      start: true,
      role: "PLAN",
      size: "VETRA_AGENT_M",
    }),
  );
  return id;
}

describe("plan instance documents", () => {
  it("are linked as PLAN, owned by the service, sized by the plan, with the holder as ADMINS", async () => {
    const envs = new FakeEnvs();
    const state = (await envs.getState(await planDoc(envs)))!;
    expect(state.app).toMatchObject({
      appId: "app-1",
      role: "PLAN",
      gitRef: null,
    });
    expect(state.owner).toBe(SERVICE);
    const fusion = state.services.find((s) => s.type === "FUSION")!;
    expect(fusion.selectedRessource).toBe("VETRA_AGENT_M");
    expect(fusion.version).toBe(image.tag);
    expect(state.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(
      HOLDER,
    );
  });

  it("are updated (size included) like any instance, and nothing else is", async () => {
    const envs = new FakeEnvs();
    const id = await planDoc(envs);
    const state = (await envs.getState(id))!;
    expect(
      instanceUpdateActions(
        state,
        image,
        HOLDER,
        settings,
        true,
        "VETRA_AGENT_M",
      ),
    ).toEqual([]);
    const resize = instanceUpdateActions(
      state,
      image,
      HOLDER,
      settings,
      true,
      "VETRA_AGENT_L",
    );
    expect(resize.map((a) => a.type)).toEqual(["SET_SERVICE_SIZE"]);
    const other = await envs.seedStandalone();
    await envs.link(other, "app-1", "PRODUCTION");
    const production = (await envs.getState(other))!;
    expect(() =>
      instanceUpdateActions(production, image, HOLDER, settings),
    ).toThrow(/not an instance/);
  });
});
