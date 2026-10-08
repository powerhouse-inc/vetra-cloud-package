import { describe, expect, it } from "vitest";
import { createReactorDocGateway } from "../doc-gateway.js";
import { OperationRejectedError } from "../publisher-errors.js";

function client(opsAfter: { error?: string; action: { id: string; type: string } }[], exists = true) {
  return {
    createEmpty: async () => ({ header: { id: "new-id" } }),
    execute: async () => undefined,
    get: async (id: string) => {
      if (!exists) throw new Error(`Document not found: ${id}`);
      return { header: { revision: { global: 3 } } };
    },
    getOperations: async () => ({ results: opsAfter }),
  };
}
const act = { id: "a1", type: "ADD_TERM", input: {}, scope: "global" } as never;

describe("createReactorDocGateway", () => {
  it("creates and returns the id", async () => {
    expect(await createReactorDocGateway(client([]), "powerhouse/vetra-app", "app").create()).toBe("new-id");
  });
  it("passes when every action was applied cleanly", async () => {
    await expect(createReactorDocGateway(client([{ action: { id: "a1", type: "ADD_TERM" } }]), "t", "app").execute("d", [act])).resolves.toBeUndefined();
  });
  it("throws OperationRejectedError with the reducer message", async () => {
    const gw = createReactorDocGateway(client([{ error: "kind x is already used by this app", action: { id: "a1", type: "ADD_TERM" } }]), "t", "app");
    await expect(gw.execute("d", [act])).rejects.toThrow(new OperationRejectedError("ADD_TERM rejected: kind x is already used by this app"));
  });
  it("throws when an action was not applied", async () => {
    await expect(createReactorDocGateway(client([]), "t", "app").execute("d", [act])).rejects.toThrow("ADD_TERM was not applied to app d");
  });
  it("throws for a missing document", async () => {
    await expect(createReactorDocGateway(client([], false), "t", "app").execute("d", [act])).rejects.toThrow("app d not found");
  });
});
