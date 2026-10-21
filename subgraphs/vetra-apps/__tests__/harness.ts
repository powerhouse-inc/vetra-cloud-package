import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { vi } from "vitest";
import type { Action } from "document-model";
import {
  reducer,
  utils,
  setOwner,
  setLabel,
  initialize,
  enableService,
  approveChanges,
  setAppLink,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { up } from "../db/migrations.js";
import { up as upObservability } from "../../vetra-cloud-observability/db/migrations.js";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import {
  RenownOrgsUnavailableError,
  type AppPublisher,
  type OrgMembership,
} from "../../../shared/renown-orgs.js";
import type { VetraAppsDB } from "../db/schema.js";
import type { VetraAppsConfig } from "../config.js";
import type { EnvGateway } from "../envs.js";
import {
  GithubHttpError,
  RepoNameTakenError,
  type GithubDeployApi,
} from "../github.js";
import type { HarborApi } from "../harbor.js";
import type { RenownApi } from "../renown.js";
import {
  ciDeployApp,
  type AppsDeps,
  type CiIdentity,
  type DeployAppInput,
} from "../service.js";
import type { Caller } from "../auth.js";

export const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const ADMIN = "0xcccccccccccccccccccccccccccccccccccccccc";
export const APP_DID = "did:key:zDnaeAppIdentity";
export const USER_KEY = "did:key:zDnaeOwnerBrowser";
export const REPO_ID = "4242";
export const REPO = "acme/shop";
export const INSTALLATION = "77";

export const owner: Caller = {
  address: OWNER,
  chainId: 1,
  appKey: USER_KEY,
  isAdmin: false,
};
export const stranger: Caller = {
  address: STRANGER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};
export const admin: Caller = {
  address: ADMIN,
  chainId: 1,
  appKey: null,
  isAdmin: true,
};
export const ORG = "org-acme";
export const MEMBER = "0xdddddddddddddddddddddddddddddddddddddddd";
export const member: Caller = {
  address: MEMBER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};

export function fakeOrgs() {
  const self = {
    members: new Map<string, OrgMembership>(),
    apps: new Map<string, string[]>(),
    publishers: new Map<string, AppPublisher>(),
    down: false,
    join(
      orgId: string,
      address: string,
      role: OrgMembership["role"],
      scope: string[] | "ALL" = "ALL",
    ) {
      self.members.set(`${orgId}|${address.toLowerCase()}`, {
        role,
        effectiveScope:
          scope === "ALL"
            ? { all: true, appDids: [] }
            : { all: false, appDids: scope },
      });
    },
    async membership(orgId: string, address: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.members.get(`${orgId}|${address.toLowerCase()}`) ?? null;
    },
    async orgApps(orgId: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.apps.get(orgId) ?? null;
    },
    async appPublisher(appDid: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.publishers.get(appDid) ?? null;
    },
    /** Profiles whose publisher is this person (as appProfilesByPublisher). */
    async personApps(address: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      const addr = address.toLowerCase();
      return [...self.publishers]
        .filter(([, p]) => !p.orgId && p.address?.toLowerCase() === addr)
        .map(([did]) => did);
    },
  };
  return self;
}

export const appIdentity: Caller = {
  address: OWNER,
  chainId: 1,
  appKey: APP_DID,
  isAdmin: false,
};

type Doc = ReturnType<typeof utils.createDocument>;

/** In-memory env documents driven by the real reducer. */
export class FakeEnvs implements EnvGateway {
  docs = new Map<string, Doc>();
  deleted: string[] = [];
  executed: { id: string; types: string[] }[] = [];
  private seq = 0;

  async create(): Promise<string> {
    const id = `env-${++this.seq}`;
    this.docs.set(id, utils.createDocument());
    return id;
  }

  async execute(
    id: string,
    actions: Action[],
  ): Promise<VetraCloudEnvironmentState> {
    let doc = this.docs.get(id);
    if (!doc) throw new Error(`no document ${id}`);
    this.executed.push({ id, types: actions.map((a) => a.type) });
    for (const a of actions) {
      doc = reducer(doc, a as never);
      const err = doc.operations.global.at(-1)?.error;
      if (err) throw new Error(`${a.type} rejected: ${err}`);
    }
    this.docs.set(id, doc);
    return doc.state.global;
  }

  async getState(id: string): Promise<VetraCloudEnvironmentState | null> {
    return this.docs.get(id)?.state.global ?? null;
  }

  async delete(id: string): Promise<void> {
    if (!this.docs.delete(id)) throw new Error(`no document ${id}`);
    this.deleted.push(id);
  }

  /** Simulate the processor/reconciler finishing a deploy. */
  setStatus(id: string, status: VetraCloudEnvironmentState["status"]) {
    const doc = this.docs.get(id)!;
    this.docs.set(id, {
      ...doc,
      state: { ...doc.state, global: { ...doc.state.global, status } },
    });
  }

  /** A standalone, deployed env owned by `address`. */
  async seedStandalone(address = OWNER): Promise<string> {
    const id = await this.create();
    await this.execute(id, [
      setLabel({ label: "standalone" }),
      initialize({
        genericSubdomain: `sub-${id}`,
        genericBaseDomain: "vetra.io",
        defaultPackageRegistry: "https://registry.vetra.io",
      }),
      setOwner({ address }),
      enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
      enableService({ type: "CONNECT", prefix: "connect" }),
      approveChanges({}),
    ]);
    this.setStatus(id, "READY");
    return id;
  }

  link(
    id: string,
    appId: string,
    role: "PRODUCTION" | "PREVIEW",
    prNumber: number | null = null,
  ) {
    return this.execute(id, [
      setAppLink({ appId, role, prNumber, gitRef: null, imageProject: null }),
    ]);
  }
}

export function fakeGithub(): GithubDeployApi & {
  calls: Record<string, unknown[][]>;
  /** PR number → state; "error" simulates GitHub being unreachable. Default open. */
  prStates: Map<number, "open" | "closed" | "error">;
  /** Repo path → contents, for toolchain detection. Absent path reads as null. */
  files: Map<string, string>;
  /** Repo names (`login/name`) that already exist; createRepoAsUser throws RepoNameTakenError for these. */
  takenRepoNames: Set<string>;
  /** Account login → the status GitHub refuses repo creation with (403, 404). */
  forbiddenAccounts: Map<string, number>;
  /** Installation id → repository selection ("missing": the lookup 404s); absent reads as "all". */
  repositorySelection: Map<string, "all" | "selected" | "missing">;
  /** Statuses addRepoToInstallation fails with, one per call, in order. */
  addRepoFailures: number[];
  /** The owner GitHub puts new repos under instead of the account (null: the account). */
  repoOwnerOverride: { login: string | null };
  /** The user-token delete answers 404 (the repo is not reachable with it). */
  userDeleteMissing: { value: boolean };
  /** Every recorded call name, in call order. */
  order: string[];
  /** What listUserInstallations answers (any app; the Vetra Deploy app is 1001). */
  installations: {
    installationId: string;
    appId: string;
    accountLogin: string;
    accountType: string;
  }[];
  /** Org login → the caller's membership (absent: active admin; null: not a member). */
  memberships: Map<string, { state: string; role: string } | null>;
} {
  const prStates = new Map<number, "open" | "closed" | "error">();
  const files = new Map<string, string>();
  const calls: Record<string, unknown[][]> = {};
  const order: string[] = [];
  const rec =
    <T>(name: string, result: (...args: any[]) => T) =>
    async (...args: any[]) => {
      (calls[name] ??= []).push(args);
      order.push(name);
      return result(...args);
    };
  let deploymentSeq = 0;
  let repoSeq = 0;
  const takenRepoNames = new Set<string>();
  const forbiddenAccounts = new Map<string, number>();
  const repositorySelection = new Map<string, "all" | "selected" | "missing">();
  const addRepoFailures: number[] = [];
  const repoOwnerOverride = { login: null as string | null };
  const userDeleteMissing = { value: false };
  const installations = [
    {
      installationId: INSTALLATION,
      appId: "1001",
      accountLogin: "acme",
      accountType: "Organization",
    },
    {
      installationId: "99",
      appId: "5555",
      accountLogin: "other-app",
      accountType: "User",
    },
  ];
  const memberships = new Map<string, { state: string; role: string } | null>();
  let pushTokenSeq = 0;
  return {
    calls,
    installations,
    memberships,
    getOrgMembership: rec("getOrgMembership", (_token: string, org: string) =>
      memberships.has(org)
        ? memberships.get(org)!
        : { state: "active", role: "admin" },
    ),
    createRepoPushToken: rec("createRepoPushToken", () => ({
      token: `ghs_push_${++pushTokenSeq}`,
      expiresAt: "2026-10-02T13:00:00.000Z",
    })),
    order,
    files,
    takenRepoNames,
    forbiddenAccounts,
    repositorySelection,
    addRepoFailures,
    repoOwnerOverride,
    userDeleteMissing,
    createRepoAsUser: rec(
      "createRepoAsUser",
      (_token: string, account: { login: string }, name: string) => {
        const fullName = `${repoOwnerOverride.login ?? account.login}/${name}`;
        const refused = forbiddenAccounts.get(account.login);
        if (refused) throw new GithubHttpError(refused, "Not allowed");
        if (takenRepoNames.has(fullName))
          throw new RepoNameTakenError(`${fullName} exists`);
        takenRepoNames.add(fullName);
        return {
          id: String(9000 + ++repoSeq),
          fullName,
          private: true,
          defaultBranch: "main",
        };
      },
    ),
    addRepoToInstallation: rec("addRepoToInstallation", () => {
      const status = addRepoFailures.shift();
      if (status) throw new GithubHttpError(status, "add failed");
    }),
    getInstallationRepositorySelection: rec(
      "getInstallationRepositorySelection",
      (installationId: string) => {
        const selection = repositorySelection.get(installationId) ?? "all";
        if (selection === "missing")
          throw new GithubHttpError(404, "Not Found");
        return selection;
      },
    ),
    deleteRepo: rec("deleteRepo", () => true),
    deleteRepoAsUser: rec("deleteRepoAsUser", () => !userDeleteMissing.value),
    setRepoVariable: rec("setRepoVariable", () => undefined),
    commitFile: rec("commitFile", () => undefined),
    getRepoFile: rec("getRepoFile", (_i: string, _r: string, path: string) =>
      files.has(path) ? files.get(path)! : null,
    ),
    exchangeOAuthCode: rec("exchangeOAuthCode", (code: string) => {
      if (code === "bad") throw new Error("bad_verification_code");
      return {
        accessToken: "user-token",
        expiresInSec: 8 * 3600,
        refreshToken: "refresh-1",
        refreshTokenExpiresInSec: 184 * 86400,
      };
    }),
    refreshUserToken: rec("refreshUserToken", (refreshToken: string) => {
      if (refreshToken !== "refresh-1") throw new Error("bad_refresh_token");
      return {
        accessToken: "user-token-2",
        expiresInSec: 8 * 3600,
        refreshToken: "refresh-2",
        refreshTokenExpiresInSec: 184 * 86400,
      };
    }),
    listUserInstallations: rec("listUserInstallations", () => [
      ...installations,
    ]),
    // What the USER can see in the installation (not every installation repo).
    listUserInstallationRepos: rec("listUserInstallationRepos", () => [
      { id: REPO_ID, fullName: REPO, private: true, defaultBranch: "main" },
      {
        id: "4343",
        fullName: "acme/blog",
        private: false,
        defaultBranch: "main",
      },
    ]),
    prStates,
    getPullRequestState: rec(
      "getPullRequestState",
      (_i: string, _r: string, n: number) => {
        const st = prStates.get(n) ?? "open";
        if (st === "error") throw new Error("GitHub unreachable");
        return st;
      },
    ),
    createDeployment: rec("createDeployment", () => String(++deploymentSeq)),
    createDeploymentStatus: rec("createDeploymentStatus", () => undefined),
    upsertPrComment: rec("upsertPrComment", () => undefined),
    openPullRequestWithFile: rec(
      "openPullRequestWithFile",
      () => `https://github.com/${REPO}/pull/9`,
    ),
  };
}

export function fakeHarbor(): HarborApi & {
  projects: string[];
  existing: Set<string>;
  deletedRobots: number[];
  deletedProjects: string[];
} {
  const projects: string[] = [];
  const existing = new Set<string>();
  const deletedRobots: number[] = [];
  const deletedProjects: string[] = [];
  let robotSeq = 0;
  return {
    projects,
    existing,
    deletedRobots,
    deletedProjects,
    async createProject(p) {
      if (existing.has(p)) return false;
      existing.add(p);
      projects.push(p);
      return true;
    },
    async createPushRobot(p) {
      return {
        id: ++robotSeq,
        name: `robot$${p}+vetra-deploy-abc123`,
        secret: "robot-secret",
      };
    },
    async deleteRobot(id) {
      deletedRobots.push(id);
    },
    async deleteProject(p) {
      existing.delete(p);
      const i = projects.indexOf(p);
      if (i >= 0) projects.splice(i, 1);
      deletedProjects.push(p);
    },
  };
}

/** A workload identity as the fake Renown stores it, per repository id. */
export interface FakeIdentity {
  did: string;
  ownerOrgId: string | null;
  ownerAddress: string;
}

export function fakeRenown(): RenownApi & {
  /** The owner's newest valid delegation for the App DID, or null. */
  delegation: { expiresAt: string | null } | null;
  registered: unknown[];
  /** Registered identities by repository id (Renown is idempotent per repo). */
  identities: Map<string, FakeIdentity>;
  deleted: string[];
  updated: unknown[];
  /** One-shot: the next registerWorkloadIdentity throws (then resets). */
  failNextRegistration: boolean;
} {
  const self = {
    delegation: null as { expiresAt: string | null } | null,
    registered: [] as unknown[],
    identities: new Map<string, FakeIdentity>(),
    deleted: [] as string[],
    updated: [] as unknown[],
    failNextRegistration: false,
    // As the served API (A5/M11): the same address gets the existing identity
    // back unchanged (whatever its organisation); another address, CONFLICT.
    async registerWorkloadIdentity(input: {
      repositoryId: string;
      ownerAddress: string;
      ownerOrgId?: string;
    }) {
      if (self.failNextRegistration) {
        self.failNextRegistration = false;
        throw new Error("renown: registration failed");
      }
      self.registered.push(input);
      const existing = self.identities.get(input.repositoryId);
      if (existing) {
        if (
          existing.ownerAddress.toLowerCase() !==
          input.ownerAddress.toLowerCase()
        ) {
          throw new Error(
            "renown: CONFLICT repository is registered by another address",
          );
        }
        return { did: existing.did, ownerOrgId: existing.ownerOrgId };
      }
      // One DID per repository (the seeded App's repository gets APP_DID).
      const created: FakeIdentity = {
        did:
          input.repositoryId === REPO_ID
            ? APP_DID
            : `did:key:zDnaeRepo${input.repositoryId}`,
        ownerOrgId: input.ownerOrgId ?? null,
        ownerAddress: input.ownerAddress,
      };
      self.identities.set(input.repositoryId, created);
      return { did: created.did, ownerOrgId: created.ownerOrgId };
    },
    async updateWorkloadIdentity(did: string, patch: unknown) {
      self.updated.push({ did, patch });
    },
    async deleteWorkloadIdentity(did: string) {
      self.deleted.push(did);
      for (const [repo, id] of self.identities) {
        if (id.did === did) self.identities.delete(repo);
      }
    },
    async getDelegation(_input: {
      address: string;
      chainId: number;
      did: string;
    }): Promise<{ expiresAt: string | null } | null> {
      return self.delegation;
    },
  };
  return self;
}

export function testConfig(
  over: Partial<VetraAppsConfig> = {},
): VetraAppsConfig {
  return {
    github: {
      appId: "1001",
      slug: "vetra-deploy",
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      privateKey: "unused",
    },
    webhookSecret: "whsec",
    harbor: {
      url: "https://cr.vetra.io",
      username: "robot$apps-admin",
      password: "pw",
    },
    renown: {
      switchboardUrl: "https://switchboard.renown.vetra.io",
      registrationToken: "reg",
    },
    encryptionKey: Buffer.alloc(32, 7),
    vetraAppUrl: "https://vetra.io",
    renownWebUrl: "https://www.renown.id",
    ciAudience:
      "https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps",
    productionRegistry: "https://registry.vetra.io",
    previewRegistry: "https://registry.dev.vetra.io",
    studioAppSlug: "vetra-studio",
    ...over,
  };
}

export interface Harness {
  deps: AppsDeps;
  db: Kysely<VetraAppsDB>;
  envs: FakeEnvs;
  github: ReturnType<typeof fakeGithub>;
  harbor: ReturnType<typeof fakeHarbor>;
  renown: ReturnType<typeof fakeRenown>;
  orgs: ReturnType<typeof fakeOrgs>;
  /** The observability tables (expected organisation hand-overs), same database. */
  obsDb: Kysely<ObservabilityDB>;
  clock: { now: Date };
  close(): Promise<void>;
}

export async function makeHarness(
  cfg: VetraAppsConfig = testConfig(),
): Promise<Harness> {
  const db = new Kysely<VetraAppsDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  // Observability's tables live in their own namespace in production; one
  // database is enough here (no table names overlap).
  await upObservability(db as Kysely<any>);
  const obsDb = db as unknown as Kysely<ObservabilityDB>;
  const orgs = fakeOrgs();
  const envs = new FakeEnvs();
  const github = fakeGithub();
  const harbor = fakeHarbor();
  const renown = fakeRenown();
  const clock = { now: new Date("2026-10-02T12:00:00.000Z") };
  let idSeq = 0;
  const deps: AppsDeps = {
    db,
    envs,
    cfg,
    github,
    harbor,
    renown,
    orgs,
    orgHandoverDb: obsDb,
    generateSubdomain: (id) => `sub-${id}`,
    now: () => {
      // strictly increasing timestamps keep created_at ordering deterministic
      clock.now = new Date(clock.now.getTime() + 1);
      return clock.now;
    },
    newId: () => `id-${++idSeq}`,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return {
    deps,
    db,
    envs,
    github,
    harbor,
    renown,
    orgs,
    obsDb,
    clock,
    close: () => db.destroy(),
  };
}

/** createApp with a connected installation, then mark the identity ACTIVE. */
export async function seedActiveApp(
  h: Harness,
  name = "Shop",
  productionEnvironmentId?: string,
) {
  const { createApp, connectGithubDeploy, confirmAppIdentity } =
    await import("../service.js");
  await connectGithubDeploy(h.deps, owner, "code");
  const app = await createApp(h.deps, owner, {
    name,
    installationId: INSTALLATION,
    repositoryId: REPO_ID,
    productionEnvironmentId,
  });
  h.renown.delegation = { expiresAt: "2027-10-02T12:00:00.000Z" };
  return confirmAppIdentity(h.deps, owner, app.id);
}

/** A C1 `vetra` claim for `ref` (refClass / eventName derived from the ref). */
export const claim = (ref: string, extra: Record<string, unknown> = {}) => {
  const pr = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
  return {
    ref,
    refClass: pr
      ? "PREVIEW"
      : ref.startsWith("refs/tags/")
        ? "RELEASE"
        : "PRODUCTION",
    eventName: pr ? "pull_request" : "push",
    prNumber: pr ? Number(pr[1]) : null,
    repositoryId: REPO_ID,
    repository: REPO,
    actor: "octocat",
    sha: "abcdef1234567",
    ...extra,
  };
};

/** The App identity (CI) with `vetra` claim `c`, as the CI routes authenticate it. */
export const ciIdentity = (c: ReturnType<typeof claim> | null): CiIdentity => ({
  address: OWNER,
  chainId: 1,
  appDid: APP_DID,
  claim: c,
});

export const deployAsCi = (
  deps: AppsDeps,
  c: ReturnType<typeof claim> | null,
  input: DeployAppInput,
) => ciDeployApp(deps, ciIdentity(c), input);
