import type { Kysely } from "kysely";
import type { DB as EnvironmentsDB } from "../../processors/vetra-cloud-environment/schema.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { isFusionHost } from "../../processors/vetra-cloud-environment/gitops.js";
import type { MembershipReader } from "../../shared/org-access.js";
import type { VetraAppsDB } from "./db/schema.js";
import { envUrls } from "./envs.js";

/**
 * The directory an App's own site asks "where does this person's <App> run?"
 * (e.g. sektar.io's "Open your Sektar"): the signed-in caller's environments
 * that run the App, with the address to open. Only ever the caller's own:
 * environments they own, or of an organisation they are a member of. No
 * platform-admin bypass; this is "my environments", not a lookup.
 */
export interface DirectoryEnvironment {
  environmentId: string;
  name: string;
  /** Where the App opens: the host's address in host mode, else its Connect. */
  connectUrl: string;
  kind: "vetra";
}

/** The environments-row fields the directory reads. */
export interface DirectoryEnvRow {
  id: string;
  name: string | null;
  subdomain: string | null;
  owner: string | null;
  ownerOrgId: string | null;
  appId: string | null;
  appRole: string | null;
  packages: string | null;
  /** JSON VetraCloudFusionConfig: its image says which App's image it runs. */
  fusion: string | null;
  status: string | null;
}

/** What makes an environment run the App. */
export interface AppMarks {
  /** Package names the App deployed. */
  packages: string[];
  /** Repository prefix of the App's images (cr.vetra.io/<harbor project>/), or null. */
  imagePrefix: string | null;
}

export interface DirectoryDeps {
  /** The App's packages and image prefix (any of them makes an env "run it"). */
  appMarks(appId: string): Promise<AppMarks>;
  /** Environments linked to the App, installing one of its packages or running its image. */
  candidates(appId: string, marks: AppMarks): Promise<DirectoryEnvRow[]>;
  getState(id: string): Promise<VetraCloudEnvironmentState | null>;
  orgs: MembershipReader | null;
}

/** Statuses of environments that are gone or going: never listed. */
const RELEASED = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

function installs(row: DirectoryEnvRow, packages: ReadonlySet<string>): boolean {
  if (packages.size === 0 || !row.packages) return false;
  try {
    const list = JSON.parse(row.packages) as { name?: unknown }[];
    return Array.isArray(list) && list.some((p) => typeof p.name === "string" && packages.has(p.name));
  } catch {
    return false;
  }
}

function runsImage(row: DirectoryEnvRow, prefix: string | null): boolean {
  if (!prefix || !row.fusion) return false;
  try {
    const image = (JSON.parse(row.fusion) as { image?: unknown } | null)?.image;
    return typeof image === "string" && image.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * Whether the row runs the App: linked to it (previews aside), installing its
 * package, or running its image (a host made from the App's FUSION image).
 */
export function runsApp(row: DirectoryEnvRow, appId: string, marks: AppMarks): boolean {
  if (row.status && RELEASED.has(row.status)) return false;
  if (row.appId === appId) return row.appRole !== "PREVIEW";
  return installs(row, new Set(marks.packages)) || runsImage(row, marks.imagePrefix);
}

async function isCallers(deps: DirectoryDeps, caller: string, row: DirectoryEnvRow): Promise<boolean> {
  if (!row.ownerOrgId) return row.owner?.toLowerCase() === caller;
  if (!deps.orgs) return false;
  try {
    return (await deps.orgs.membership(row.ownerOrgId, caller)) !== null;
  } catch {
    return false; // Renown unreachable: list nothing rather than guess
  }
}

/** The address to open: a host image serves Connect at the App's own address. */
export function openUrl(state: VetraCloudEnvironmentState): string | null {
  const urls = envUrls(state);
  return isFusionHost(state) ? urls.app : (urls.connect ?? urls.app);
}

export async function listDirectory(
  deps: DirectoryDeps,
  callerAddress: string,
  appId: string,
): Promise<DirectoryEnvironment[]> {
  const caller = callerAddress.toLowerCase();
  const marks = await deps.appMarks(appId);
  const rows = (await deps.candidates(appId, marks)).filter((r) => runsApp(r, appId, marks));
  const out: DirectoryEnvironment[] = [];
  for (const row of rows) {
    if (!(await isCallers(deps, caller, row))) continue;
    const state = await deps.getState(row.id);
    const url = state ? openUrl(state) : null;
    if (!url) continue;
    out.push({
      environmentId: row.id,
      name: state?.label ?? row.name ?? row.subdomain ?? row.id,
      connectUrl: url,
      kind: "vetra",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** appMarks over the apps tables: every package name an App deployed, and its image prefix. */
export function appMarksIn(db: Kysely<VetraAppsDB>, harborHost: string): DirectoryDeps["appMarks"] {
  return async (appId) => {
    const app = await db
      .selectFrom("apps")
      .select("harbor_project")
      .where("id", "=", appId)
      .executeTakeFirst();
    const rows = await db
      .selectFrom("app_deployments")
      .select("packages")
      .where("app_id", "=", appId)
      .execute();
    const names = new Set<string>();
    for (const r of rows) {
      try {
        for (const p of JSON.parse(r.packages) as { name?: unknown }[]) {
          if (typeof p.name === "string") names.add(p.name);
        }
      } catch {
        // a malformed row names nothing
      }
    }
    return {
      packages: [...names],
      imagePrefix: app?.harbor_project ? `${harborHost}/${app.harbor_project}/` : null,
    };
  };
}

/** candidates over the environments read model (namespace "vetra-cloud-environments"). */
export function candidatesIn(db: Kysely<EnvironmentsDB>): DirectoryDeps["candidates"] {
  return async (appId, marks) => {
    // Query builder (not raw table SQL) so the namespace qualifies the table;
    // the package match is narrowed with LIKE and decided by runsApp.
    const rows = await db
      .selectFrom("environments")
      .select(["id", "name", "subdomain", "owner", "ownerOrgId", "appId", "appRole", "packages", "fusion", "status"])
      .where((eb) =>
        eb.or([
          eb("appId", "=", appId),
          ...marks.packages.map((name) => eb("packages", "like", `%"name":${JSON.stringify(name)}%`)),
          ...(marks.imagePrefix
            ? [eb("fusion", "like", `%"image":${JSON.stringify(marks.imagePrefix).slice(0, -1)}%`)]
            : []),
        ]),
      )
      .limit(500)
      .execute();
    return rows as DirectoryEnvRow[];
  };
}
