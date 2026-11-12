import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "document-model";
import { reducer, utils } from "../../../document-models/vetra-app/v1/index.js";
import {
  ciIdentity,
  claim,
  makeHarness,
  owner,
  OWNER,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciReportRelease } from "../releases/service.js";
import { listReleases } from "../releases/repo.js";
import { listAudit } from "../audit/repo.js";
import { updateApp } from "../service.js";

type Doc = ReturnType<typeof utils.createDocument>;

/** App documents run through the real vetra-app reducer. */
function appDocs() {
  const docs = new Map<string, Doc>();
  return {
    docs,
    executed: [] as Action[][],
    failing: false,
    /** Delay before a state read answers, to interleave concurrent reports. */
    readDelayMs: 0,
    async create(id: string) {
      docs.set(id, utils.createDocument());
    },
    async exists(id: string) {
      return docs.has(id);
    },
    async getState(id: string) {
      const state = (docs.get(id)?.state.global ?? null) as Record<
        string,
        unknown
      > | null;
      if (this.readDelayMs)
        await new Promise((r) => setTimeout(r, this.readDelayMs));
      return state;
    },
    async execute(id: string, actions: Action[]) {
      if (this.failing) throw new Error("reactor down");
      let doc = docs.get(id);
      if (!doc) throw new Error(`no document ${id}`);
      for (const a of actions) doc = reducer(doc, a as never) as Doc;
      docs.set(id, doc);
      this.executed.push(actions);
    },
  };
}

let h: Harness;
let app: Awaited<ReturnType<typeof seedActiveApp>>;
let docs: ReturnType<typeof appDocs>;
let policy: "AUTO" | "GATED";
beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
  h.orgs.personHandles.set(OWNER, "acme");
  h.deps.attestations = { verify: async () => {} };
  docs = appDocs();
  h.deps.docs = docs;
  policy = "AUTO";
  h.deps.releasePolicy = async () => policy;
});
afterEach(async () => {
  await h.close();
});

const SHA = "abcdef1234567";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const report = (
  version: string,
  over: Record<string, unknown> = {},
  ref = "refs/heads/main",
  runId = "500",
) =>
  ciReportRelease(
    h.deps,
    ciIdentity(claim(ref, { runId, releaseBranch: true })),
    {
      appId: app.id,
      version,
      kind: "release",
      branch: "main",
      pr: null,
      commit: SHA,
      notes: null,
      image: {
        ref: `cr.vetra.io/acme/${app.slug}:${version}`,
        digest: digest("a"),
        host: "cli",
      },
      packages: [],
      requires: {},
      migrates: false,
      built: { powerhouse: "6.2.3", baseImage: "node:24@sha256:00" },
      ...over,
    },
  );

type Artifact = {
  kind: string;
  name: string;
  versions: {
    version: string;
    reference: string;
    commitSha: string | null;
    runId: string | null;
  }[];
  channels: { channel: string; version: string }[];
};
const hostArtifact = async () =>
  ((await docs.getState(app.id))?.artifacts as Artifact[] | undefined)?.find(
    (a) => a.kind === "FUSION_IMAGE" && a.name === "host",
  );
const pointer = async (channel: string) =>
  (await hostArtifact())?.channels.find((c) => c.channel === channel)
    ?.version ?? null;

/** The old CI path's record (vetra-deploy-action: `host` at a commit tag, on LATEST). */
async function oldPathLatest(version = "sha-cac9276bc10b") {
  if (!(await docs.exists(app.id))) await docs.create(app.id);
  await docs.execute(app.id, [
    {
      type: "RECORD_ARTIFACT_VERSION",
      input: {
        kind: "FUSION_IMAGE",
        name: "host",
        version,
        reference: `cr.vetra.io/app-${app.slug}/host:${version}`,
        commitSha: "cac9276",
        runId: "1",
        publishedAt: "2026-11-01T00:00:00.000Z",
      },
      scope: "global",
    } as unknown as Action,
    {
      type: "SET_ARTIFACT_CHANNEL",
      input: { kind: "FUSION_IMAGE", name: "host", channel: "LATEST", version },
      scope: "global",
    } as unknown as Action,
  ]);
}

describe("a release feeds licensed environments' host image", () => {
  it("records the release's image as the host FUSION_IMAGE on LATEST", async () => {
    await report("1.5.0");
    const host = await hostArtifact();
    expect(host?.versions).toMatchObject([
      {
        version: "1.5.0",
        reference: `cr.vetra.io/acme/${app.slug}:1.5.0@${digest("a")}`,
        commitSha: SHA,
        runId: "500",
      },
    ]);
    expect(await pointer("LATEST")).toBe("1.5.0");
    expect(await pointer("STAGING")).toBeNull();
  });

  it("moves STAGING instead for a gated App", async () => {
    policy = "GATED";
    await oldPathLatest();
    await report("1.0.10");
    expect(await pointer("STAGING")).toBe("1.0.10");
    expect(await pointer("LATEST")).toBe("sha-cac9276bc10b");
    // Recorded after the commit tag: licensing orders them by the record.
    expect((await hostArtifact())?.versions.map((v) => v.version)).toEqual([
      "sha-cac9276bc10b",
      "1.0.10",
    ]);
  });

  it("supersedes the old path's commit-tag LATEST", async () => {
    await oldPathLatest();
    await report("1.0.10");
    expect(await pointer("LATEST")).toBe("1.0.10");
  });

  it("leaves a commit-tag channel recorded after the release (the old path ran later)", async () => {
    await report("1.0.10");
    await oldPathLatest("sha-0123456789ab");
    await report("1.0.10", {}, "refs/heads/main", "501");
    expect(await pointer("LATEST")).toBe("sha-0123456789ab");
  });

  it("records nothing for a build", async () => {
    await report("1.5.0-main.4", {
      kind: "build",
      image: {
        ref: `cr.vetra.io/acme/${app.slug}:1.5.0-main.4`,
        digest: digest("a"),
        host: "cli",
      },
    });
    expect(docs.executed).toEqual([]);
    expect(await hostArtifact()).toBeUndefined();
  });

  it("records nothing for a prerelease", async () => {
    await updateApp(h.deps, owner, app.id, { releaseBranches: ["next"] });
    await report("2.0.0-beta.1", { branch: "next" }, "refs/heads/next", "600");
    expect(await listReleases(h.deps.db, app.id, { limit: 5 })).toHaveLength(1);
    expect(await hostArtifact()).toBeUndefined();
  });

  it("never moves the channel back: a maintenance release is recorded but LATEST stays", async () => {
    await report("1.1.0");
    await report("1.0.11", {}, "refs/heads/main", "501");
    expect(await pointer("LATEST")).toBe("1.1.0");
    expect((await hostArtifact())?.versions.map((v) => v.version)).toEqual([
      "1.1.0",
      "1.0.11",
    ]);
  });

  it("is harmless when CI retries, also after a newer release", async () => {
    await report("1.5.0");
    await report("1.5.0", {}, "refs/heads/main", "501");
    expect((await hostArtifact())?.versions).toHaveLength(1);
    expect(await pointer("LATEST")).toBe("1.5.0");
    await report("1.6.0", {}, "refs/heads/main", "502");
    await report("1.5.0", {}, "refs/heads/main", "503");
    expect(await pointer("LATEST")).toBe("1.6.0");
    expect((await hostArtifact())?.versions.map((v) => v.version)).toEqual([
      "1.5.0",
      "1.6.0",
    ]);
  });

  it("leaves the channel on the newer release when two reports race", async () => {
    await report("1.0.0");
    docs.readDelayMs = 50;
    await Promise.all([
      report("1.6.0", {}, "refs/heads/main", "501"),
      report("1.5.0", {}, "refs/heads/main", "502"),
    ]);
    expect(await pointer("LATEST")).toBe("1.6.0");
  });

  it("keeps the release when the document write fails, asks CI to retry, and the retry records it", async () => {
    docs.failing = true;
    await expect(report("1.5.0")).rejects.toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
      message: expect.stringMatching(
        /^1\.5\.0 is recorded, but .*App document could not be written.*; retry/,
      ),
    });
    expect(
      (await listReleases(h.deps.db, app.id, { limit: 5 })).map(
        (r) => r.version,
      ),
    ).toEqual(["1.5.0"]);
    docs.failing = false;
    await expect(
      report("1.5.0", {}, "refs/heads/main", "501"),
    ).resolves.toMatchObject({
      version: "1.5.0",
      run: 500,
    });
    expect(await pointer("LATEST")).toBe("1.5.0");
  });

  it("audits the release once across a failed document write and its retry", async () => {
    docs.failing = true;
    await expect(report("1.5.0")).rejects.toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
    });
    // The release row is stored, so its audit row is too (same transaction).
    expect(
      (await listAudit(h.db, app.id, { limit: 10 })).map((r) => [
        r.action,
        r.subject,
      ]),
    ).toEqual([["release.recorded", "release:1.5.0"]]);
    docs.failing = false;
    await report("1.5.0", {}, "refs/heads/main", "501");
    expect(await pointer("LATEST")).toBe("1.5.0");
    const rows = await listAudit(h.db, app.id, { limit: 10 });
    expect(rows.map((r) => r.action)).toEqual(["release.recorded"]);
    expect(JSON.parse(rows[0].detail)).toMatchObject({
      run: 500,
      githubRun: "500",
    });
  });

  it("asks CI to retry when the release policy cannot be read", async () => {
    h.deps.releasePolicy = async () => {
      throw new Error("licensing db down");
    };
    await expect(report("1.5.0")).rejects.toMatchObject({
      extensions: { code: "SERVICE_UNAVAILABLE" },
      message: expect.stringMatching(
        /^1\.5\.0 is recorded, but .*release policy could not be read from vetra-licensing.*; retry/,
      ),
    });
    expect(await hostArtifact()).toBeUndefined();
  });
});
