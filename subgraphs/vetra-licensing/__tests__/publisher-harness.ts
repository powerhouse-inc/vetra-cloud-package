import { randomUUID } from "node:crypto";
import type { GraphQLError } from "graphql";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createLifecycleStore } from "../lifecycle.js";
import { createGrantStore } from "../grants.js";
import { createChainEnvironmentRows } from "../environments.js";
import { loadLicensingConfig } from "../config.js";
import { createOwnerAppLookup } from "../owner-apps.js";
import type { OwnerAppRecord } from "../publisher-auth.js";
import {
  createAppLedger,
  createAppLicensingWriter,
  reactorLedgerSource,
} from "../licensing-ledger.js";
import type { KeyVault } from "../key-vault.js";
import { createPublisherResolvers, type PublisherDeps } from "../publisher-resolvers.js";

export const NOW = "2026-10-08T00:00:00.000Z";

export type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
export type Resolvers = {
  VetraPublisherQueries: Record<string, Field>;
  VetraPublisherMutations: Record<string, Field>;
};

export const asUser = (address: string) => ({
  user: { address, networkId: "eip155", chainId: 1 },
  isAdmin: () => false,
});

/** The GraphQL error code a call ends with, or "OK". */
export async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as GraphQLError).extensions?.code ?? `UNMAPPED: ${String(e)}`;
  }
}

/**
 * The publisher resolvers against a real reactor (vetra-app and licence
 * documents), the real app-state ledger and PGlite. Ownership comes from the
 * in-memory `apps` table rows, never from documents.
 */
export async function createPublisherHarness() {
  const client = await new ReactorClientBuilder()
    .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
    .build();
  const db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  const now = () => NOW;

  const ledger = createAppLedger({ db, source: reactorLedgerSource(client as never), now });
  const apps = createAppReads(client as never, { ledger: ledger.lookup, heal: ledger.heal });
  // Unrecorded on purpose: an app the migration has not seeded yet.
  const appDocs = createReactorAppDocStore(client as never);
  const rows = new Map<string, OwnerAppRecord>();
  const auth = createOwnerAppLookup({
    table: {
      byId: async (id) => rows.get(id) ?? null,
      byOwner: async (address) => [...rows.values()].filter((r) => r.owner_address === address),
    },
    apps,
    studioPublisher: null,
  });
  const appGateway = createReactorDocGateway(client as never, APP_DOC_TYPE, "app", async () => {
    throw new Error("the publisher surface never creates app documents");
  });
  const appWriter = createAppLicensingWriter({ docs: appGateway, ledger });
  const reads = createReactorLicenseReads(client as never);
  const lifecycle = createLifecycleStore(db, now);
  const licenseGateway = createReactorLicenseGateway(client as never, { lifecycle });
  const grants = createGrantStore(db);
  const cfg = { ...loadLicensingConfig({}), enabled: true };
  const keyVault: KeyVault = {
    encrypt: async (p) => `enc:${p}`,
    decrypt: async (c) => c.slice(4),
  };

  /** Environments each app owns (production, previews), as the apps tables record them. */
  const ownedEnvironments = new Map<string, string[]>();
  const deps: PublisherDeps = {
    appEnvironments: async (appId) => ownedEnvironments.get(appId) ?? [],
    auth,
    apps,
    appWriter,
    licences: reads,
    lifecycle,
    licenseGateway,
    issue: {
      owners: auth,
      apps,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: licenseGateway.create,
      executeLicence: licenseGateway.execute,
      grants,
      lifecycle,
      logger: console,
    },
    grants,
    envRows: createChainEnvironmentRows(db, cfg),
    codes: db,
    keyVault,
    cfg,
    newId: () => randomUUID(),
    now,
  };
  const build = (over: Partial<PublisherDeps> = {}) =>
    createPublisherResolvers({ ...deps, ...over }) as unknown as Resolvers;

  /** An app: an `apps` row (the ownership authority) and its document. */
  async function addApp(id: string, owner: string, status = "ACTIVE") {
    rows.set(id, { id, name: `App ${id.slice(0, 4)}`, status, owner_address: owner });
    await appDocs.create(id);
  }

  /** A document's global revision and global state, to prove nothing changed. */
  const revisionOf = async (id: string): Promise<number | undefined> =>
    (await client.get(id)).header.revision.global;
  const stateOf = async (id: string): Promise<unknown> =>
    ((await client.get(id)).state as unknown as { global: unknown }).global;

  return { client, db, cfg, deps, lifecycle, build, addApp, ledger, apps, reads, licenseGateway, rows, revisionOf, stateOf, ownedEnvironments };
}

export type PublisherHarness = Awaited<ReturnType<typeof createPublisherHarness>>;
