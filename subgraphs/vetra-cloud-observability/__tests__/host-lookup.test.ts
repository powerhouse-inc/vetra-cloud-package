import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { buildASTSchema, parse, validate } from "graphql";
import { up as upEnvironments } from "../../../processors/vetra-cloud-environment/migrations.js";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import {
  candidateSubdomains,
  isKnownEnvironmentHost,
  normalizeHost,
} from "../host-lookup.js";
import { createResolvers } from "../resolvers.js";
import { schema } from "../schema.js";

const svc = (type: string, prefix: string, extra: Record<string, unknown> = {}) => ({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "ACTIVE",
  version: null,
  config: null,
  selectedRessource: null,
  ...extra,
});
const fusionSvc = () => svc("FUSION", "fusion", { version: "1.2.3" });
/** A Sektar host: the FUSION app runs as the env's switchboard and Connect. */
const sektarFusion = JSON.stringify({
  image: "cr.vetra.io/app-sektar/sektar",
  env: [{ name: "PH_HOST", value: "cli", isSecret: false }],
  autoUpdate: false,
  autoUpdateTagPattern: null,
});
const both = JSON.stringify([svc("SWITCHBOARD", "switchboard"), svc("CONNECT", "connect")]);

type Row = {
  id: string;
  subdomain: string;
  status: string | null;
  services: string;
  fusion?: string | null;
  customDomain?: string | null;
  customDomainEnabled?: boolean | null;
  apexService?: string | null;
  genericBaseDomain?: string | null;
};

const ROWS: Row[] = [
  { id: "plain", subdomain: "tall-duck-ab12", status: "READY", services: both },
  {
    id: "sektar",
    subdomain: "brave-owl-cd34",
    status: "READY",
    services: JSON.stringify([fusionSvc()]),
    fusion: sektarFusion,
  },
  // Enabled custom domain, no apex: generic hosts stay, custom hosts are not known.
  {
    id: "custom",
    subdomain: "calm-fox-ef56",
    status: "READY",
    services: both,
    customDomain: "acme.com",
    customDomainEnabled: true,
  },
  // FUSION at the apex of an enabled custom domain: no generated FUSION host.
  {
    id: "custom-apex",
    subdomain: "keen-elk-0a1b",
    status: "READY",
    services: JSON.stringify([fusionSvc()]),
    fusion: sektarFusion,
    customDomain: "sektar.example.com",
    customDomainEnabled: true,
    apexService: "FUSION",
  },
  // Same, custom domain switched off: the generated apex host is served.
  {
    id: "custom-off",
    subdomain: "warm-yak-2c3d",
    status: "READY",
    services: JSON.stringify([fusionSvc()]),
    fusion: sektarFusion,
    customDomain: "off.com",
    customDomainEnabled: false,
    apexService: "FUSION",
  },
  { id: "destroyed", subdomain: "gone-cat-0001", status: "DESTROYED", services: both },
  { id: "terminating", subdomain: "gone-cat-0002", status: "TERMINATING", services: both },
  { id: "archived", subdomain: "gone-cat-0003", status: "ARCHIVED", services: both },
  { id: "unreported", subdomain: "new-ant-4e5f", status: null, services: both },
  {
    id: "own-base",
    subdomain: "ok-bee-6a7b",
    status: "READY",
    services: both,
    genericBaseDomain: "example.org",
  },
  {
    id: "one-off",
    subdomain: "lone-ram-8c9d",
    status: "READY",
    services: JSON.stringify([
      svc("SWITCHBOARD", "switchboard", { enabled: false }),
      svc("CONNECT", "connect"),
    ]),
  },
  { id: "junk", subdomain: "junk-pig-0000", status: "READY", services: "not json" },
];

describe("vetraEnvironmentHostKnown", () => {
  let envDb: Kysely<any>;

  beforeAll(async () => {
    envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await upEnvironments(envDb);
    await envDb.insertInto("environments").values(ROWS).execute();
  });

  afterAll(async () => {
    await envDb.destroy();
  });

  const known = (host: unknown) => isKnownEnvironmentHost(envDb, host);

  it.each([
    "tall-duck-ab12-switchboard.vetra.io",
    "tall-duck-ab12-connect.vetra.io",
    "brave-owl-cd34.vetra.io", // sole FUSION service claims the apex
    "calm-fox-ef56-switchboard.vetra.io",
    "warm-yak-2c3d.vetra.io",
    "new-ant-4e5f-connect.vetra.io", // no status yet counts as live
    "ok-bee-6a7b-connect.example.org",
    "lone-ram-8c9d.vetra.io", // the only enabled service is at the apex
  ])("knows the generated host %s", async (host) => {
    expect(await known(host)).toBe(true);
  });

  it.each([
    // Custom-domain hosts: never known (no proof the domain routes to Vetra).
    "acme.com",
    "switchboard.acme.com",
    "connect.acme.com",
    "sektar.example.com",
    "off.com",
    "switchboard.off.com",
    // FUSION at an enabled custom apex has no generated host.
    "keen-elk-0a1b.vetra.io",
    "keen-elk-0a1b-fusion.vetra.io",
    // Hosts that are not rendered.
    "tall-duck-ab12.vetra.io", // two services, nothing at the apex
    "brave-owl-cd34-fusion.vetra.io", // FUSION is at the apex instead
    "brave-owl-cd34-switchboard.vetra.io", // a FUSION host replaces switchboard
    "lone-ram-8c9d-switchboard.vetra.io", // disabled service
    "tall-duck-ab12-clint.vetra.io",
    "ok-bee-6a7b-connect.vetra.io", // wrong base domain
    "tall-duck-ab12-connect.vetra.io.evil.com",
    "evil-tall-duck-ab12-connect.vetra.io",
    // Released environments.
    "gone-cat-0001-connect.vetra.io",
    "gone-cat-0002-connect.vetra.io",
    "gone-cat-0003-connect.vetra.io",
    // Unknown.
    "nobody-here-0000.vetra.io",
    "vetra.io",
    "junk-pig-0000.vetra.io",
  ])("does not know %s", async (host) => {
    expect(await known(host)).toBe(false);
  });

  it.each([
    "TALL-DUCK-AB12-CONNECT.VETRA.IO",
    "tall-duck-ab12-connect.vetra.io.",
    "tall-duck-ab12-connect.vetra.io:443",
    "Tall-Duck-AB12-Connect.Vetra.IO.:8443",
  ])("normalizes case, trailing dot and port: %s", async (host) => {
    expect(await known(host)).toBe(true);
  });

  it.each([
    "",
    " ",
    "tall-duck-ab12-connect.vetra.io..",
    "tall-duck-ab12-connect..vetra.io",
    ".tall-duck-ab12-connect.vetra.io",
    "tall duck.vetra.io",
    "https://tall-duck-ab12-connect.vetra.io",
    "tall-duck-ab12-connect.vetra.io/oauth/callback",
    "user@tall-duck-ab12-connect.vetra.io",
    "tall-duck-ab12-connect.vetra.io:",
    "tall-duck-ab12-connect.vetra.io:123456",
    "-tall.vetra.io",
    "tall-.vetra.io",
    "tall_duck.vetra.io",
    "[::1]",
    "[::1]:443",
    "localhost",
    `${"a".repeat(64)}.vetra.io`,
    `${"a.".repeat(126)}vetra.io`, // 255 chars
    "x".repeat(10_000),
    123,
    null,
    undefined,
    { host: "tall-duck-ab12-connect.vetra.io" },
  ])("answers false for malformed input %j", async (host) => {
    expect(await known(host)).toBe(false);
  });

  it("answers false (not an error) when the read model fails", async () => {
    const broken = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    const warn = vi.fn();
    expect(
      await isKnownEnvironmentHost(broken, "tall-duck-ab12-connect.vetra.io", { warn }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    await broken.destroy();
  });

  it("is answered without a caller and returns a bare boolean", async () => {
    const db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await up(db);
      const resolvers = createResolvers(db, {
        prometheusUrl: "http://prometheus",
        lokiUrl: "http://loki",
        envDb,
        dispatch: vi.fn(async () => undefined),
      });
      const ask = (host: unknown) =>
        resolvers.Query.vetraEnvironmentHostKnown(undefined, { host }, {});
      expect(await ask("brave-owl-cd34.vetra.io")).toBe(true);
      expect(await ask("acme.com")).toBe(false);
      expect(await ask("not a host")).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it("is a query field taking one host and answering Boolean!", () => {
    const built = buildASTSchema(schema);
    const field = built.getQueryType()!.getFields().vetraEnvironmentHostKnown;
    expect(String(field.type)).toBe("Boolean!");
    expect(field.args.map((a) => `${a.name}: ${String(a.type)}`)).toEqual(["host: String!"]);
    expect(
      validate(built, parse('{ vetraEnvironmentHostKnown(host: "a.vetra.io") }')),
    ).toEqual([]);
  });
});

describe("normalizeHost / candidateSubdomains", () => {
  it("normalizes", () => {
    expect(normalizeHost("A.B.Vetra.IO.:443")).toBe("a.b.vetra.io");
    expect(normalizeHost(`${"a".repeat(63)}.io`)).toBe(`${"a".repeat(63)}.io`);
  });

  it("lists the subdomains a generated host can belong to", () => {
    expect(candidateSubdomains("tall-duck-ab12-connect.vetra.io")).toEqual([
      "tall-duck-ab12-connect",
      "tall",
      "tall-duck",
      "tall-duck-ab12",
    ]);
  });
});
