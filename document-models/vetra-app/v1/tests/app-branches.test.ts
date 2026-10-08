import { describe, expect, it } from "vitest";
import {
  connectRepository,
  recordArtifactVersion,
  reducer,
  setAppDetails,
  setArtifactChannel,
  setIdentity,
  setPreviews,
  setProductionEnvironment,
  utils,
} from "document-models/vetra-app/v1";

const lastError = (doc: { operations: Record<string, { error?: string }[]> }) =>
  doc.operations.global?.at(-1)?.error;

describe("app details, repository, identity (both sides of the fallbacks)", () => {
  it("only overwrites the app details that are provided", () => {
    let doc = reducer(
      utils.createDocument(),
      setAppDetails({
        name: "n",
        slug: "s",
        owner: "0x2bbea0145d6fb9c6709a74c1179ca0be71bb3ac6",
      }),
    );
    doc = reducer(doc, setAppDetails({}));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.name).toBe("n");
    expect(doc.state.global.slug).toBe("s");
    expect(doc.state.global.owner).toBe(
      "0x2bbea0145d6fb9c6709a74c1179ca0be71bb3ac6",
    );
    doc = reducer(doc, setAppDetails({ name: "n2", slug: null, owner: null }));
    expect(doc.state.global.name).toBe("n2");
    expect(doc.state.global.slug).toBe("s");
  });

  it("nulls missing repository, identity and production environment fields", () => {
    let doc = reducer(utils.createDocument(), connectRepository({}));
    expect(doc.state.global.repository).toStrictEqual({
      repositoryId: null,
      fullName: null,
      productionBranch: null,
    });
    doc = reducer(
      doc,
      setIdentity({ did: "did:key:z1", expiresAt: "2027-01-01T00:00:00.000Z" }),
    );
    expect(doc.state.global.identity?.did).toBe("did:key:z1");
    doc = reducer(doc, setIdentity({}));
    expect(doc.state.global.identity).toStrictEqual({
      did: null,
      expiresAt: null,
    });
    doc = reducer(doc, setProductionEnvironment({ environmentId: "env-1" }));
    expect(doc.state.global.productionEnvironmentId).toBe("env-1");
    doc = reducer(doc, setProductionEnvironment({}));
    expect(doc.state.global.productionEnvironmentId).toBeNull();
    doc = reducer(doc, setPreviews({ enabled: true, limit: 3, ttlDays: 7 }));
    expect(doc.state.global.previews).toStrictEqual({
      enabled: true,
      limit: 3,
      ttlDays: 7,
    });
  });
});

describe("artifact scenarios", () => {
  const rec = (over: Record<string, unknown> = {}) =>
    recordArtifactVersion({
      kind: "FUSION_IMAGE",
      name: "a",
      version: "1",
      reference: "ref",
      publishedAt: "2026-10-07T00:00:00.000Z",
      ...over,
    });

  it("defaults commitSha/runId to null and separates artifacts by kind and name", () => {
    let doc = reducer(utils.createDocument(), rec());
    expect(doc.state.global.artifacts[0]!.versions[0]).toMatchObject({
      commitSha: null,
      runId: null,
    });
    doc = reducer(doc, rec({ name: "b" }));
    doc = reducer(doc, rec({ kind: "PACKAGE" }));
    expect(doc.state.global.artifacts).toHaveLength(3);
  });

  it("errors when a channel targets an unpublished artifact, and tracks several channels", () => {
    let doc = reducer(
      utils.createDocument(),
      setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: "a",
        channel: "LATEST",
        version: "1",
      }),
    );
    expect(lastError(doc)).toMatch(/published nothing/);

    doc = reducer(doc, rec());
    doc = reducer(doc, rec({ version: "2" }));
    doc = reducer(
      doc,
      setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: "a",
        channel: "LATEST",
        version: "1",
      }),
    );
    doc = reducer(
      doc,
      setArtifactChannel({
        kind: "FUSION_IMAGE",
        name: "a",
        channel: "STAGING",
        version: "2",
      }),
    );
    expect(doc.state.global.artifacts[0]!.channels).toHaveLength(2);
  });
});
