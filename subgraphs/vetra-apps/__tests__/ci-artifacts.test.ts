import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "document-model";
import {
  ciIdentity,
  claim,
  makeHarness,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciRecordArtifact } from "../service.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const fakeDocs = (existing = new Set<string>()) => ({
  created: [] as string[],
  executed: [] as Array<{ id: string; actions: Action[] }>,
  async create(id: string) {
    this.created.push(id);
    existing.add(id);
  },
  async exists(id: string) {
    return existing.has(id);
  },
  async execute(id: string, actions: Action[]) {
    this.executed.push({ id, actions });
  },
  async getState() {
    return null;
  },
});

const input = (over: Record<string, unknown> = {}) => ({
  appId: "",
  kind: "FUSION_IMAGE" as const,
  name: "dtbau-psb",
  version: "1.2.3",
  reference: "cr.vetra.io/p/dtbau-psb:1.2.3",
  ...over,
});

const ci = () => ciIdentity(claim("refs/heads/main"));

describe("ciRecordArtifact", () => {
  it("records the version on the App's document", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;

    const out = await ciRecordArtifact(h.deps, ci(), input({ appId: app.id }));

    expect(out).toEqual({ appId: app.id, recorded: true });
    expect(docs.executed).toHaveLength(1);
    expect(docs.executed[0]!.actions.map((a) => a.type)).toStrictEqual([
      "RECORD_ARTIFACT_VERSION",
    ]);
  });

  it("moves the channel in the same call when one is given", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;

    await ciRecordArtifact(
      h.deps,
      ci(),
      input({ appId: app.id, channel: "LATEST" }),
    );

    expect(docs.executed[0]!.actions.map((a) => a.type)).toStrictEqual([
      "RECORD_ARTIFACT_VERSION",
      "SET_ARTIFACT_CHANNEL",
    ]);
  });

  it("creates the document on demand for an App registered before the backfill", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs();
    h.deps.docs = docs;

    await ciRecordArtifact(h.deps, ci(), input({ appId: app.id }));

    expect(docs.created).toStrictEqual([app.id]);
    expect(docs.executed).toHaveLength(1);
  });

  // The document is the ONLY record of an artifact. Swallowing this error the
  // way the row mirror does would drop the artifact and the template builder
  // would never offer it — with CI reporting success.
  it("fails loudly when the document write fails", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = {
      ...fakeDocs(new Set([app.id])),
      execute: async () => {
        throw new Error("reactor down");
      },
    };

    await expect(
      ciRecordArtifact(h.deps, ci(), input({ appId: app.id })),
    ).rejects.toThrow("reactor down");
  });

  it("refuses an App the token was not issued for", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = fakeDocs(new Set([app.id]));

    await expect(
      ciRecordArtifact(
        h.deps,
        { ...ci(), appDid: "did:key:zOther" },
        input({ appId: app.id }),
      ),
    ).rejects.toThrow(/not issued by this App/i);
  });

  it.each(["name", "version", "reference"] as const)(
    "refuses a blank %s",
    async (field) => {
      const app = await seedActiveApp(h);
      const docs = fakeDocs(new Set([app.id]));
      h.deps.docs = docs;

      await expect(
        ciRecordArtifact(
          h.deps,
          ci(),
          input({ appId: app.id, [field]: "   " }),
        ),
      ).rejects.toThrow(new RegExp(`${field} is required`));
      expect(docs.executed).toStrictEqual([]);
    },
  );

  it("refuses an unknown kind and an unknown channel", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = fakeDocs(new Set([app.id]));

    await expect(
      ciRecordArtifact(
        h.deps,
        ci(),
        input({ appId: app.id, kind: "SOMETHING" as never }),
      ),
    ).rejects.toThrow(/kind must be/);
    await expect(
      ciRecordArtifact(
        h.deps,
        ci(),
        input({ appId: app.id, channel: "PROD" as never }),
      ),
    ).rejects.toThrow(/channel must be/);
  });
});
