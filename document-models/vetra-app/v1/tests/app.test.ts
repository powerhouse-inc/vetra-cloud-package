import { describe, expect, it } from "vitest";
import {
  connectRepository,
  reducer,
  setAppDetails,
  setStatus,
  utils, isVetraAppDocument, setIdentity, setPreviews, setProductionEnvironment, recordArtifactVersion, setArtifactChannel, SetAppDetailsInputSchema, ConnectRepositoryInputSchema, SetIdentityInputSchema, SetStatusInputSchema, SetPreviewsInputSchema, SetProductionEnvironmentInputSchema, RecordArtifactVersionInputSchema, SetArtifactChannelInputSchema } from "document-models/vetra-app/v1";

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

import {
  recordArtifactVersion,
  setArtifactChannel,
} from "document-models/vetra-app/v1";

const v = (version: string, over: Record<string, unknown> = {}) =>
  recordArtifactVersion({
    kind: "FUSION_IMAGE",
    name: "dtbau-psb",
    version,
    reference: `cr.vetra.io/p/dtbau-psb:${version}`,
    commitSha: "abc",
    runId: "1",
    publishedAt: "2026-10-07T00:00:00.000Z",
    ...over,
  });

const point = (version: string) =>
  setArtifactChannel({
    kind: "FUSION_IMAGE",
    name: "dtbau-psb",
    channel: "LATEST",
    version,
  });

describe("artifacts", () => {
  it("groups versions under one artifact entry", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("1.1.0"));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.artifacts).toHaveLength(1);
    expect(
      doc.state.global.artifacts[0]!.versions.map((x) => x.version),
    ).toStrictEqual(["1.0.0", "1.1.0"]);
  });

  it("is idempotent: re-running a job overwrites that version", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("1.0.0", { commitSha: "def" }));
    const versions = doc.state.global.artifacts[0]!.versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.commitSha).toBe("def");
  });

  it("refuses a channel pointing at a version that does not exist", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, point("9.9.9"));
    // reducer rejections do not throw; they land on the appended operation
    expect(doc.operations.global.at(-1)?.error).toBeTruthy();
    expect(doc.state.global.artifacts[0]!.channels).toStrictEqual([]);
  });

  it("lets a channel move back to an older version on a republish", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("2.0.0"));
    doc = reducer(doc, point("2.0.0"));
    doc = reducer(doc, point("1.0.0"));
    expect(doc.state.global.artifacts[0]!.channels).toStrictEqual([
      { channel: "LATEST", version: "1.0.0" },
    ]);
  });

  it("caps versions per artifact and never leaves a channel on a dropped one", () => {
    let doc = reducer(utils.createDocument(), v("0.0.0"));
    doc = reducer(doc, point("0.0.0"));
    for (let i = 1; i <= 55; i++) doc = reducer(doc, v(`0.0.${i}`));

    const artifact = doc.state.global.artifacts[0]!;
    expect(artifact.versions).toHaveLength(50);
    expect(artifact.versions.some((x) => x.version === "0.0.0")).toBe(false);
    for (const channel of artifact.channels) {
      expect(artifact.versions.some((x) => x.version === channel.version)).toBe(
        true,
      );
    }
  });
});
