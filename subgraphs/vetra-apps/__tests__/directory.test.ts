import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import {
  candidatesIn,
  listDirectory,
  openUrl,
  runsApp,
  type DirectoryDeps,
  type DirectoryEnvRow,
} from "../directory.js";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APP = "app-sektar";
const PKG = "@acme/sektar";

type Svc = VetraCloudEnvironmentState["services"][number];
const svc = (type: Svc["type"], prefix: string): Svc => ({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "ACTIVE",
  version: "1",
  config: null,
  selectedRessource: null,
});

function state(
  subdomain: string,
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: null,
    ownerOrgId: null,
    orgOperators: [],
    label: subdomain,
    genericSubdomain: subdomain,
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: null,
    services: [svc("SWITCHBOARD", "switchboard"), svc("CONNECT", "connect")],
    fusion: null,
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    runtimeConfig: null,
    studioInstanceId: null,
    backupSchedule: null,
    app: null,
    ...overrides,
  } as VetraCloudEnvironmentState;
}

const hostState = (subdomain: string) =>
  state(subdomain, {
    services: [svc("FUSION", "fusion")],
    fusion: {
      image: "cr.vetra.io/app-sektar/app",
      env: [{ name: "PH_HOST", value: "cli", isSecret: false }],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    },
  });

const row = (r: Partial<DirectoryEnvRow> & { id: string }): DirectoryEnvRow => ({
  name: r.id,
  subdomain: r.id,
  owner: ME,
  ownerOrgId: null,
  appId: null,
  appRole: null,
  packages: "[]",
  status: "READY",
  ...r,
});

function deps(rows: DirectoryEnvRow[], states: Record<string, VetraCloudEnvironmentState>): DirectoryDeps {
  return {
    appPackages: async () => [PKG],
    candidates: async () => rows,
    getState: async (id) => states[id] ?? null,
    orgs: {
      membership: async (orgId, address) =>
        orgId === "org-mine" && address === ME
          ? { role: "MEMBER", status: "ACTIVE", effectiveScope: { all: false, appDids: [] } }
          : null,
    } as DirectoryDeps["orgs"],
  };
}

describe("app directory", () => {
  it("lists the caller's own and organisation environments running the App, nobody else's", async () => {
    const rows = [
      row({ id: "mine", appId: APP, appRole: "PRODUCTION" }),
      row({ id: "org", owner: OTHER, ownerOrgId: "org-mine", appId: APP, appRole: "PRODUCTION" }),
      row({ id: "theirs", owner: OTHER, appId: APP, appRole: "PRODUCTION" }),
      row({ id: "other-org", owner: OTHER, ownerOrgId: "org-other", appId: APP }),
    ];
    const out = await listDirectory(
      deps(rows, { mine: state("calm-bat"), org: state("sage-crow"), theirs: state("x"), "other-org": state("y") }),
      ME.toUpperCase().replace("0X", "0x"),
      APP,
    );
    expect(out.map((e) => e.environmentId)).toStrictEqual(["mine", "org"]);
    expect(out[0]).toStrictEqual({
      environmentId: "mine",
      name: "calm-bat",
      connectUrl: "https://calm-bat-connect.vetra.io",
      kind: "vetra",
    });
  });

  it("opens a host image at the App's own address, not a Connect service", async () => {
    const out = await listDirectory(
      deps([row({ id: "host", appId: APP, appRole: "PRODUCTION" })], { host: hostState("bold-owl") }),
      ME,
      APP,
    );
    // FUSION is the only service: served at the generic apex
    expect(out[0]?.connectUrl).toBe("https://bold-owl.vetra.io");
  });

  it("opens a host image at its custom domain when it is the apex", () => {
    const s = hostState("bold-owl");
    s.customDomain = { enabled: true, domain: "frank.sektar.app", dnsRecords: [] };
    s.apexService = "FUSION";
    expect(openUrl(s)).toBe("https://frank.sektar.app");
  });

  it("counts envs linked to the App (previews aside) or installing its package; never released ones", () => {
    const pkgs = new Set([PKG]);
    expect(runsApp(row({ id: "a", appId: APP, appRole: "PRODUCTION" }), APP, pkgs)).toBe(true);
    expect(runsApp(row({ id: "b", appId: APP, appRole: "PREVIEW" }), APP, pkgs)).toBe(false);
    expect(runsApp(row({ id: "c", packages: JSON.stringify([{ name: PKG, version: "1" }]) }), APP, pkgs)).toBe(true);
    expect(runsApp(row({ id: "d", packages: JSON.stringify([{ name: "@acme/other" }]) }), APP, pkgs)).toBe(false);
    expect(runsApp(row({ id: "e", appId: APP, status: "DESTROYED" }), APP, pkgs)).toBe(false);
    expect(runsApp(row({ id: "f", packages: "not json" }), APP, pkgs)).toBe(false);
  });

  it("lists nothing for an organisation env when Renown is unreachable", async () => {
    const d = deps([row({ id: "org", owner: OTHER, ownerOrgId: "org-mine", appId: APP })], { org: state("o") });
    d.orgs = { membership: async () => { throw new Error("down"); } } as DirectoryDeps["orgs"];
    expect(await listDirectory(d, ME, APP)).toStrictEqual([]);
  });

  it("finds candidates in the environments read model of the namespace schema", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-cloud-environments"`.execute(root);
      await sql`CREATE TABLE "vetra-cloud-environments".environments (
        id text PRIMARY KEY, name text, subdomain text, owner text, "ownerOrgId" text,
        "appId" text, "appRole" text, packages text, status text)`.execute(root);
      const db = root.withSchema("vetra-cloud-environments");
      await db
        .insertInto("environments")
        .values([
          { id: "linked", appId: APP, packages: "[]" },
          { id: "installs", packages: JSON.stringify([{ name: PKG, version: "1", registry: "r" }]) },
          { id: "unrelated", packages: JSON.stringify([{ name: "@acme/sektar-extra" }]) },
        ])
        .execute();
      const found = await candidatesIn(db)(APP, [PKG]);
      expect(found.map((r) => r.id).sort()).toStrictEqual(["installs", "linked"]);
    } finally {
      await root.destroy();
    }
  });
});
