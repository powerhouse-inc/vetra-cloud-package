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
import type { VetraAppsDB } from "../db/schema.js";
import type { VetraAppsConfig } from "../config.js";
import type { EnvGateway } from "../envs.js";
import type { GithubDeployApi } from "../github.js";
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
} {
  const calls: Record<string, unknown[][]> = {};
  const rec =
    <T>(name: string, result: (...args: any[]) => T) =>
    async (...args: any[]) => {
      (calls[name] ??= []).push(args);
      return result(...args);
    };
  let deploymentSeq = 0;
  return {
    calls,
    exchangeOAuthCode: rec("exchangeOAuthCode", (code: string) => {
      if (code === "bad") throw new Error("bad_verification_code");
      return "user-token";
    }),
    listUserInstallations: rec("listUserInstallations", () => [
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
    ]),
    listInstallationRepos: rec("listInstallationRepos", () => [
      { id: REPO_ID, fullName: REPO, private: true, defaultBranch: "main" },
      {
        id: "4343",
        fullName: "acme/blog",
        private: false,
        defaultBranch: "main",
      },
    ]),
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
} {
  const projects: string[] = [];
  const existing = new Set<string>();
  const deletedRobots: number[] = [];
  let robotSeq = 0;
  return {
    projects,
    existing,
    deletedRobots,
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
  };
}

export function fakeRenown(): RenownApi & {
  delegated: boolean;
  registered: unknown[];
  deleted: string[];
  updated: unknown[];
} {
  const self = {
    delegated: false,
    registered: [] as unknown[],
    deleted: [] as string[],
    updated: [] as unknown[],
    async registerWorkloadIdentity(input: unknown) {
      self.registered.push(input);
      return { did: APP_DID };
    },
    async updateWorkloadIdentity(did: string, patch: unknown) {
      self.updated.push({ did, patch });
    },
    async deleteWorkloadIdentity(did: string) {
      self.deleted.push(did);
    },
    async hasDelegation() {
      return self.delegated;
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
    generateSubdomain: (id) => `sub-${id}`,
    now: () => {
      // strictly increasing timestamps keep created_at ordering deterministic
      clock.now = new Date(clock.now.getTime() + 1);
      return clock.now;
    },
    newId: () => `id-${++idSeq}`,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return {
    deps,
    db,
    envs,
    github,
    harbor,
    renown,
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
  h.renown.delegated = true;
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
