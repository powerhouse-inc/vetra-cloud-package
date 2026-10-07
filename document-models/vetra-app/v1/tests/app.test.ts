import { describe, expect, it } from "vitest";
import {
  connectRepository,
  reducer,
  setAppDetails,
  setStatus,
  utils,
} from "document-models/vetra-app/v1";

describe("VetraApp", () => {
  it("starts PENDING_IDENTITY with no artifacts", () => {
    const doc = utils.createDocument();
    expect(doc.state.global.status).toBe("PENDING_IDENTITY");
    expect(doc.state.global.artifacts).toStrictEqual([]);
  });

  it("records details and the repository without touching the other", () => {
    let doc = reducer(
      utils.createDocument(),
      setAppDetails({
        name: "dtbau",
        slug: "dtbau",
        owner: "0x2bbea0145d6fb9c6709a74c1179ca0be71bb3ac6",
      }),
    );
    doc = reducer(
      doc,
      connectRepository({
        repositoryId: "r1",
        fullName: "web3-berlin/dtbau-package",
        productionBranch: "main",
      }),
    );
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.name).toBe("dtbau");
    expect(doc.state.global.repository?.fullName).toBe(
      "web3-berlin/dtbau-package",
    );
  });

  it("carries DELETED, because soft-deleted rows are kept forever", () => {
    const doc = reducer(
      utils.createDocument(),
      setStatus({ status: "DELETED" }),
    );
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.status).toBe("DELETED");
  });
});
