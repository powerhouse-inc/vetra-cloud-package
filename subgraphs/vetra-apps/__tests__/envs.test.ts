import { describe, expect, it } from "vitest";
import {
  addPackage,
  approveChanges,
  initialize,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";
import { createReactorEnvGateway } from "../envs.js";
import { FakeReactorClient } from "./fake-reactor.js";

async function setup() {
  const client = new FakeReactorClient();
  const envs = createReactorEnvGateway(client as never);
  const id = await envs.create();
  await envs.execute(id, [
    initialize({
      genericSubdomain: "s",
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: null,
    }),
  ]);
  return { client, envs, id };
}

describe("EnvGateway over the reactor client (I3/I4)", () => {
  it("surfaces a reducer rejection that is only visible via getOperations", async () => {
    const { client, envs, id } = await setup();
    client.rejectTypes.add("ADD_PACKAGE");
    await expect(
      envs.execute(id, [
        addPackage({ packageName: "x", version: "1", registry: null }),
      ]),
    ).rejects.toThrow(/ADD_PACKAGE is not allowed now/);
  });

  it("succeeds when every appended op is clean", async () => {
    const { envs, id } = await setup();
    const state = await envs.execute(id, [
      addPackage({ packageName: "x", version: "1", registry: null }),
      approveChanges({}),
    ]);
    expect(state.packages[0]?.name).toBe("x");
  });

  it("getState: null only for a definite not-found; transient errors are rethrown", async () => {
    const { client, envs, id } = await setup();
    expect(await envs.getState("missing")).toBeNull();
    await client.deleteDocument(id);
    expect(await envs.getState(id)).toBeNull();
    const other = await envs.create();
    client.transient.add(other);
    await expect(envs.getState(other)).rejects.toThrow(/connection terminated/);
  });
});
