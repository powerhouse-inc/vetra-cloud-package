import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  addPackage,
  removePackage,
  enableService,
  disableService,
  setServiceConfig,
  setServiceSize,
} from "document-models/vetra-cloud-environment/v1";

/**
 * Environment documents created before `packages` / `services` existed are
 * still replayed in production. The reducers must keep treating a missing list as
 * empty instead of failing the operation. (Inputs are schema-validated before
 * the reducer runs, so a missing `env` in an input never reaches it.)
 */

type LegacyGlobal = Record<string, unknown>;

function legacyDocument(drop: string[]) {
  const doc = utils.createDocument();
  const global = doc.state.global as unknown as LegacyGlobal;
  for (const key of drop) delete global[key];
  return doc;
}

const lastError = (doc: { operations: Record<string, { error?: string }[]> }) =>
  doc.operations.global?.at(-1)?.error;

const pkg = { registry: "https://r", name: "p" };

describe("replaying operations on legacy environment state", () => {
  it("adds and removes packages on a document without a packages list", () => {
    let doc = reducer(legacyDocument(["packages"]), addPackage({ packageName: "a" }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.packages).toStrictEqual([{ registry: "", name: "a", version: "latest" }]);

    doc = reducer(legacyDocument(["packages"]), removePackage({ packageName: "a" }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.packages).toStrictEqual([]);
  });

  it("enables, configures, sizes and disables services on a document without a services list", () => {
    let doc = reducer(
      legacyDocument(["services"]),
      enableService({ type: "CLINT", prefix: "agent", clintConfig: { package: pkg, env: [] } }),
    );
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.services.map((s) => s.prefix)).toStrictEqual(["agent"]);

    doc = reducer(legacyDocument(["services"]), disableService({ type: "CLINT", prefix: "agent" }));
    expect(doc.state.global.services).toStrictEqual([]);

    doc = reducer(
      legacyDocument(["services"]),
      setServiceConfig({ prefix: "agent", config: { package: pkg, env: [] } }),
    );
    expect(lastError(doc)).toMatch(/No service with prefix 'agent'/);

    doc = reducer(legacyDocument(["services"]), setServiceSize({ prefix: "agent", size: "VETRA_AGENT_S" }));
    expect(lastError(doc)).toMatch(/agent/);
  });
});
