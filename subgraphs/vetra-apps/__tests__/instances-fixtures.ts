import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { insertRelease, type ReleaseRow } from "../releases/repo.js";
import { getApp } from "../repo.js";
import { OWNER, type Harness } from "./harness.js";

export const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A recorded build or release of the app, as ciReportRelease stores it. */
export async function seedRelease(
  h: Harness,
  appId: string,
  over: {
    version: string;
    run: number;
    branch?: string | null;
    pr?: number | null;
    kind?: "build" | "release";
    digest?: string;
    createdAt?: string;
  },
): Promise<ReleaseRow> {
  const app = (await getApp(h.db, appId))!;
  const { row } = await insertRelease(h.db, {
    app_id: appId,
    version: over.version,
    kind: over.kind ?? "build",
    branch: over.pr != null ? null : (over.branch ?? "main"),
    pr: over.pr ?? null,
    run: over.run,
    commit: "abcdef1234567",
    notes: null,
    customer_notes: null,
    image_ref: `cr.vetra.io/acme/${app.slug}:${over.version}`,
    image_digest: over.digest ?? digest("a"),
    host: "cli",
    packages: "[]",
    requires: "{}",
    migrates: false,
    powerhouse_version: "6.2.3",
    base_image: "node:24@sha256:00",
    created_at: over.createdAt ?? "2026-11-11T00:00:00.000Z",
  });
  return row;
}

const lic = (h: Harness) => h.db as unknown as Kysely<VetraLicensingDB>;

/** A licence as issueLicense records it: grant, chain link, lifecycle. */
export async function seedLicence(
  h: Harness,
  o: {
    appId: string;
    kind: string | null;
    holder: string;
    licenseId: string;
    root?: string;
    status?: string;
    endAt?: string | null;
  },
): Promise<void> {
  const at = "2026-10-01T00:00:00.000Z";
  await lic(h)
    .insertInto("app_license_grants")
    .values({
      license_id: o.licenseId,
      app_id: o.appId,
      license_type_id: o.kind ?? "legacy",
      user_address: o.holder.toLowerCase(),
      issued_by: OWNER,
      created_at: at,
      kind: o.kind,
      user_did: `did:pkh:eip155:1:${o.holder.toLowerCase()}`,
    })
    .execute();
  await lic(h)
    .insertInto("license_chain")
    .values({
      license_id: o.licenseId,
      root_license_id: o.root ?? o.licenseId,
      app_id: o.appId,
      label: null,
      created_at: at,
    })
    .execute();
  await lic(h)
    .insertInto("license_lifecycle")
    .values({
      license_id: o.licenseId,
      status: o.status ?? "ACTIVE",
      end_at: o.endAt ?? null,
      replaced_by: null,
      updated_at: at,
    })
    .execute();
}

/** A licensed environment of the old model for a chain (Sektar's kind of row). */
export async function seedLicensedEnvironment(
  h: Harness,
  o: { appId: string; root: string; environmentId?: string },
): Promise<void> {
  const at = "2026-10-01T00:00:00.000Z";
  await lic(h)
    .insertInto("license_environments")
    .values({
      environment_id: o.environmentId ?? `licensed-${o.root}`,
      root_license_id: o.root,
      app_id: o.appId,
      user_did: "did:pkh:eip155:1:0x0",
      license_id: o.root,
      template_id: "template-1",
      label: null,
      template_hash: "h",
      ended_at: null,
      stopped_at: null,
      delete_after: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}
