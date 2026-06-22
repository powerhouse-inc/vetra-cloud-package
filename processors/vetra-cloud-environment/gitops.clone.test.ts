import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWorkingClone } from "./gitops.js";

/** Run git synchronously in a dir, returning trimmed stdout. */
function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Create a bare repo seeded with one commit on `main`, return its path. */
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

/** Push a file straight to the bare remote via a throwaway clone (simulates another writer). */
function pushExternalCommit(root: string, bare: string, file: string, body: string): void {
  const ext = mkdtempSync(join(root, "ext-"));
  runGit(["clone", "--branch", "main", bare, "."], ext);
  runGit(["config", "user.name", "ext"], ext);
  runGit(["config", "user.email", "ext@test"], ext);
  writeFileSync(join(ext, file), body, "utf-8");
  runGit(["add", "."], ext);
  runGit(["commit", "-m", `external ${file}`], ext);
  runGit(["push", "origin", "main"], ext);
}

describe("withWorkingClone — persistent warm gitops clone", () => {
  let root: string;
  let bare: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitops-clone-test-"));
    bare = setupRemote(root);
    for (const k of ["GITOPS_REPO_URL", "GITOPS_REPO_PATH", "GITOPS_BRANCH", "GITOPS_REMOTE", "GITOPS_WORK_DIR", "GITOPS_GITHUB_PAT"]) {
      prevEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GITOPS_REPO_URL = bare;
    process.env.GITOPS_BRANCH = "main";
    process.env.GITOPS_WORK_DIR = join(root, "work");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses the same working directory across calls (no re-clone)", async () => {
    let dir1 = "";
    let dir2 = "";
    await withWorkingClone(async (cloneDir) => {
      dir1 = cloneDir;
      // leave an untracked stray file behind
      writeFileSync(join(cloneDir, "stray.tmp"), "x", "utf-8");
    });
    await withWorkingClone(async (cloneDir) => {
      dir2 = cloneDir;
    });
    expect(dir2).toBe(dir1);
    // stray file from the first run must be gone — proves a pristine reset
    expect(existsSync(join(dir1, "stray.tmp"))).toBe(false);
  });

  it("resets to latest origin/main, picking up external commits", async () => {
    await withWorkingClone(async () => {
      /* first call just clones */
    });
    pushExternalCommit(root, bare, "outside.txt", "hello-outside\n");

    let seenBody: string | null = null;
    await withWorkingClone(async (cloneDir) => {
      const p = join(cloneDir, "outside.txt");
      seenBody = existsSync(p) ? readFileSync(p, "utf-8") : null;
    });
    expect(seenBody).toBe("hello-outside\n");
  });

  it("commits and pushes from the working clone reach the remote", async () => {
    await withWorkingClone(async (cloneDir) => {
      writeFileSync(join(cloneDir, "tenants-marker.txt"), "deployed\n", "utf-8");
      runGit(["add", "."], cloneDir);
      runGit(["commit", "-m", "add marker"], cloneDir);
      runGit(["push", "origin", "main"], cloneDir);
    });
    // verify the bare remote now has the file on main
    const tree = runGit(["ls-tree", "--name-only", "main"], bare);
    expect(tree.split("\n")).toContain("tenants-marker.txt");
  });
});
