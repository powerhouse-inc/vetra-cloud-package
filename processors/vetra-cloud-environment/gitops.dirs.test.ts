import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import {
  deleteEnvironmentFromGitops,
  gcOrphanTenantDirs,
  getTenantId,
  gitopsTenantDir,
  syncEnvironment,
} from "./gitops.js";
import { MANAGED_MARKER } from "./gc.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// Preview envs live under previews/<tenantId> (their own ApplicationSet with
// preserveResourcesOnDeletion: false cascade-deletes them); everything else
// stays under tenants/<tenantId>.

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupRemote(root: string): string {
  const bare = join(root, "remote.git");
  mkdirSync(bare, { recursive: true });
  runGit(["init", "--bare", "--initial-branch=main", "."], bare);
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  runGit(["init", "--initial-branch=main", "."], seed);
  runGit(["config", "user.name", "seed"], seed);
  runGit(["config", "user.email", "seed@test"], seed);
  writeFileSync(join(seed, "README.md"), "seed\n", "utf-8");
  runGit(["add", "."], seed);
  runGit(["commit", "-m", "seed"], seed);
  runGit(["remote", "add", "origin", bare], seed);
  runGit(["push", "origin", "main"], seed);
  return bare;
}

/** Seed managed (or unmanaged) values files straight into the remote. */
function seedDirs(root: string, bare: string, paths: string[], managed = true): void {
  const ext = mkdtempSync(join(root, "ext-"));
  runGit(["clone", "--branch", "main", bare, "."], ext);
  runGit(["config", "user.name", "ext"], ext);
  runGit(["config", "user.email", "ext@test"], ext);
  for (const p of paths) {
    mkdirSync(join(ext, p), { recursive: true });
    writeFileSync(
      join(ext, p, "powerhouse-values.yaml"),
      `${managed ? MANAGED_MARKER : "# hand-written"}\nglobal: {}\n`,
      "utf-8",
    );
  }
  runGit(["add", "."], ext);
  runGit(["commit", "-m", "seed dirs"], ext);
  runGit(["push", "origin", "main"], ext);
}

const files = (bare: string) => runGit(["ls-tree", "-r", "--name-only", "main"], bare).split("\n");

const dbStub = {} as Kysely<DB>;

function state(over: Partial<VetraCloudEnvironmentState> = {}): VetraCloudEnvironmentState {
  return {
    owner: null,
    label: "shop",
    genericSubdomain: "calm-wolf",
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.vetra.io",
    services: [],
    fusion: null,
    packages: [],
    status: "CHANGES_APPROVED",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    app: null,
    ...over,
  };
}
const PREVIEW = { appId: "app-1", role: "PREVIEW" as const, prNumber: 7, gitRef: null, imageProject: null };
const PRODUCTION = { ...PREVIEW, role: "PRODUCTION" as const, prNumber: null };
const DOC = "abcdef12-0000-0000-0000-000000000000";
const TENANT = getTenantId("calm-wolf", DOC);

describe("gitops directory per env role", () => {
  let root: string;
  let bare: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitops-dirs-test-"));
    bare = setupRemote(root);
    for (const k of ["GITOPS_REPO_URL", "GITOPS_REPO_PATH", "GITOPS_BRANCH", "GITOPS_REMOTE", "GITOPS_WORK_DIR", "GITOPS_GITHUB_PAT"]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GITOPS_REPO_URL = bare;
    process.env.GITOPS_BRANCH = "main";
    process.env.GITOPS_WORK_DIR = join(root, "work");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("gitopsTenantDir: previews/ for PREVIEW, tenants/ for standalone and PRODUCTION (unchanged)", () => {
    expect(gitopsTenantDir(state({ app: PREVIEW }), TENANT)).toBe(`previews/${TENANT}`);
    expect(gitopsTenantDir(state(), TENANT)).toBe(`tenants/${TENANT}`);
    expect(gitopsTenantDir(state({ app: PRODUCTION }), TENANT)).toBe(`tenants/${TENANT}`);
    const legacy = state();
    delete (legacy as Partial<VetraCloudEnvironmentState>).app;
    expect(gitopsTenantDir(legacy, TENANT)).toBe(`tenants/${TENANT}`);
  });

  it("a preview env is written under previews/<tenantId>, a standalone env under tenants/<tenantId>", async () => {
    await syncEnvironment(dbStub, state({ app: PREVIEW }), DOC);
    expect(files(bare)).toContain(`previews/${TENANT}/powerhouse-values.yaml`);
    expect(files(bare)).not.toContain(`tenants/${TENANT}/powerhouse-values.yaml`);

    const DOC2 = "12345678-0000-0000-0000-000000000000";
    await syncEnvironment(dbStub, state({ genericSubdomain: "bold-bear" }), DOC2);
    expect(files(bare)).toContain(`tenants/${getTenantId("bold-bear", DOC2)}/powerhouse-values.yaml`);
  });

  it("a role change moves the dir: the other root's copy is removed on write", async () => {
    await syncEnvironment(dbStub, state({ app: PRODUCTION }), DOC);
    expect(files(bare)).toContain(`tenants/${TENANT}/powerhouse-values.yaml`);
    await syncEnvironment(dbStub, state({ app: PREVIEW }), DOC);
    expect(files(bare)).toContain(`previews/${TENANT}/powerhouse-values.yaml`);
    expect(files(bare)).not.toContain(`tenants/${TENANT}/powerhouse-values.yaml`);
    await syncEnvironment(dbStub, state({ app: null }), DOC);
    expect(files(bare)).toContain(`tenants/${TENANT}/powerhouse-values.yaml`);
    expect(files(bare)).not.toContain(`previews/${TENANT}/powerhouse-values.yaml`);
  });

  it("deleteEnvironmentFromGitops removes previews/<id>, tenants/<id>, or both", async () => {
    seedDirs(root, bare, [`previews/${TENANT}`, `tenants/other-1`, `previews/other-2`]);
    await deleteEnvironmentFromGitops(TENANT);
    expect(files(bare)).not.toContain(`previews/${TENANT}/powerhouse-values.yaml`);
    await deleteEnvironmentFromGitops("other-1");
    expect(files(bare)).not.toContain("tenants/other-1/powerhouse-values.yaml");
    seedDirs(root, bare, ["tenants/dup-3", "previews/dup-3"]);
    await deleteEnvironmentFromGitops("dup-3");
    expect(files(bare).filter((f) => f.includes("dup-3"))).toStrictEqual([]);
    expect(files(bare)).toContain("previews/other-2/powerhouse-values.yaml");
  });

  it("orphan GC also covers previews/, with the circuit breaker computed per root", async () => {
    seedDirs(root, bare, [
      "tenants/live-a",
      "tenants/live-b",
      "tenants/live-c",
      "tenants/orphan-t",
      "previews/live-p1",
      "previews/live-p2",
      "previews/orphan-p",
    ]);
    seedDirs(root, bare, ["previews/handmade"], false);
    const removed = await gcOrphanTenantDirs(
      new Set(["live-a", "live-b", "live-c", "live-p1", "live-p2"]),
    );
    expect(removed.sort()).toStrictEqual(["orphan-p", "orphan-t"]);
    const f = files(bare);
    expect(f).not.toContain("tenants/orphan-t/powerhouse-values.yaml");
    expect(f).not.toContain("previews/orphan-p/powerhouse-values.yaml");
    expect(f).toContain("previews/handmade/powerhouse-values.yaml"); // unmanaged: never touched
  });

  it("the breaker trips per root: a mostly-orphaned previews/ is skipped while tenants/ is cleaned", async () => {
    seedDirs(root, bare, [
      "tenants/live-a",
      "tenants/live-b",
      "tenants/live-c",
      "tenants/orphan-t",
      "previews/orphan-1",
      "previews/orphan-2",
      "previews/live-p",
    ]);
    const removed = await gcOrphanTenantDirs(new Set(["live-a", "live-b", "live-c", "live-p"]));
    expect(removed).toStrictEqual(["orphan-t"]);
    expect(files(bare)).toContain("previews/orphan-1/powerhouse-values.yaml");
  });
});
