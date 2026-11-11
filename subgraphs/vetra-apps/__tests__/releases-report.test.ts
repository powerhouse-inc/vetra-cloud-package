import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciIdentity,
  claim,
  makeHarness,
  OWNER,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { ciReportRelease } from "../releases/service.js";

let h: Harness;
let app: Awaited<ReturnType<typeof seedActiveApp>>;
const verified: unknown[] = [];
beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
  h.orgs.personHandles.set(OWNER, "acme");
  verified.length = 0;
  h.deps.attestations = {
    verify: async (i) => {
      verified.push(i);
    },
  };
});
afterEach(async () => {
  await h.close();
});

const SHA = "abcdef1234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const input = (over: Record<string, unknown> = {}) => ({
  appId: app.id,
  version: "1.5.0",
  kind: "release" as const,
  branch: "main",
  pr: null,
  commit: SHA,
  notes: "## Features\n- x",
  image: {
    ref: `cr.vetra.io/acme/${app.slug}:1.5.0`,
    digest: DIGEST,
    host: "cli",
  },
  packages: [{ name: "@acme/shop", version: "1.5.0" }],
  requires: { powerhouse: ">=6.2.3" },
  migrates: true,
  built: { powerhouse: "6.2.3", baseImage: "node:24-bookworm-slim@sha256:00" },
  ...over,
});
const ci = (ref = "refs/heads/main", runId = "500") =>
  ciIdentity(claim(ref, { runId }));

describe("ciReportRelease", () => {
  it("stores a verified release with the claim's run id and returns it", async () => {
    const out = await ciReportRelease(h.deps, ci(), input());
    expect(out).toMatchObject({
      version: "1.5.0",
      kind: "release",
      run: 500,
      customerNotes: "## Features\n- x",
      migrates: true,
    });
    expect(verified).toStrictEqual([
      {
        repository: "acme/shop",
        digest: DIGEST,
        commit: SHA,
        installationId: app.installation_id,
      },
    ]);
  });

  it("is a no-op on a re-run with the same digest, a conflict with another", async () => {
    await ciReportRelease(h.deps, ci(), input());
    await expect(
      ciReportRelease(h.deps, ci("refs/heads/main", "501"), input()),
    ).resolves.toMatchObject({ run: 500 });
    await expect(
      ciReportRelease(
        h.deps,
        ci(),
        input({
          image: {
            ref: `cr.vetra.io/acme/${app.slug}:1.5.0`,
            digest: `sha256:${"b".repeat(64)}`,
            host: "cli",
          },
        }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "VERSION_CONFLICT" } });
  });

  it("refuses an image outside the app's repository or under another tag", async () => {
    for (const ref of [
      `cr.vetra.io/other/${app.slug}:1.5.0`,
      `cr.vetra.io/acme/${app.slug}:1.5.1`,
      `ghcr.io/acme/${app.slug}:1.5.0`,
    ]) {
      await expect(
        ciReportRelease(
          h.deps,
          ci(),
          input({ image: { ref, digest: DIGEST, host: "cli" } }),
        ),
      ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
  });

  it("refuses packages at another version and notes on a build", async () => {
    await expect(
      ciReportRelease(
        h.deps,
        ci(),
        input({ packages: [{ name: "@acme/shop", version: "1.4.0" }] }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      ciReportRelease(
        h.deps,
        ci(),
        input({
          version: "1.5.0-main.4",
          kind: "build",
          image: {
            ref: `cr.vetra.io/acme/${app.slug}:1.5.0-main.4`,
            digest: DIGEST,
            host: "cli",
          },
          packages: [],
        }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("stores nothing when the attestation fails", async () => {
    h.deps.attestations = {
      verify: async () => {
        throw Object.assign(new Error("no"), {
          extensions: { code: "FORBIDDEN" },
        });
      },
    };
    await expect(ciReportRelease(h.deps, ci(), input())).rejects.toBeTruthy();
    const rows = await h.deps.db.selectFrom("releases").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
