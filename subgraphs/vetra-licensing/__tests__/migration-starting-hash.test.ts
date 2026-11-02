import { describe, expect, it, vi } from "vitest";
import type { AppDocView } from "../app-reads.js";
import { startingHash } from "../migration/steps.js";
import type { TemplateShape } from "../template.js";

const SHA_A = "sha-56e1fd7497fc";
const SHA_B = "sha-6141b974fc38";
const REPO = "cr.vetra.io/app-sektar/host";
const OWNER = "0x1111111111111111111111111111111111111111";

// LATEST moved from sha-a to sha-b: the resolved template names sha-b.
const shaTemplate: TemplateShape = {
  services: [{ id: "h", type: "FUSION", prefix: "sektar", artifactName: "host", artifactChannel: "LATEST", resolvedRepository: REPO, resolvedVersion: SHA_B }],
  packages: [], size: null, baseDomain: null, packageRegistry: null,
};

const app = (fusionVersions?: string[]): AppDocView => ({
  id: "app-1", name: "Sektar", slug: "sektar", owner: OWNER, status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, artifacts: [], tampered: false, tamperReason: null, licensingStateHash: "h", unverified: false,
  templates: [{
    id: "t-pro", name: "Pro", mode: "DEDICATED", sharedEnvironment: null, warmPoolSize: 0,
    template: shaTemplate, templateHash: "resolved-hash", resolutionError: null,
    ...(fusionVersions ? { fusionVersions } : {}),
  }],
  terms: [{ id: "k", kind: "pro", label: "Pro", templateId: "t-pro", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" }],
}) as AppDocView;

const liveOnShaA = {
  status: "READY", owner: OWNER, label: "My vault", packages: [],
  services: [{ type: "FUSION", prefix: "sektar", enabled: true, version: SHA_A, selectedRessource: null }],
  // The sektar host settings the template's FUSION service implies, already met.
  fusion: { image: REPO, env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: OWNER, isSecret: false }], autoUpdate: false, autoUpdateTagPattern: null },
};

describe("startingHash (migration re-keying of a live environment)", () => {
  const deps = { envState: vi.fn(async () => structuredClone(liveOnShaA) as never) };

  it("keeps the legacy hash while a FUSION commit-tag move is pending, so the handler moves it", async () => {
    const start = await startingHash(deps, app([SHA_A, SHA_B]), "pro", "env-1", "legacy-hash");
    expect(start).toMatchObject({ hash: "legacy-hash", templateId: "t-pro" });
    // SET_SERVICE_VERSION and its APPROVE_CHANGES.
    expect(start.note).toContain("2 update(s) pending");
  });

  it("seeds the resolved hash when the record cannot order the move (nothing pending)", async () => {
    expect(await startingHash(deps, app(), "pro", "env-1", "legacy-hash")).toMatchObject({
      hash: "resolved-hash", templateId: "t-pro", note: "meets its template; hash seeded",
    });
  });
});
