import type { RenownOrgs } from "../../../shared/renown-orgs.js";
import { appsError, notConfigured } from "../errors.js";
import type { AppsDeps } from "../service.js";
import type { AppRow } from "../repo.js";

const HARBOR_NAME = /^[a-z0-9][a-z0-9._-]{1,254}$/;

/**
 * Harbor projects a handle may never name: Harbor's default `library`, the
 * old per-app projects (`app-<slug>`), the platform's own images (`vetra`,
 * `vetra-cloud-package`, `powerhouse-inc-*`), and the fallback shapes
 * (`u-…`, `o-…`) so no handle can pre-empt another owner's fallback.
 */
const RESERVED = new Set([
  "library",
  "vetra",
  "vetra-cloud-package",
  "powerhouse-inc",
]);
const RESERVED_PREFIXES = ["app-", "powerhouse-inc-", "u-", "o-"];

const isReserved = (name: string) =>
  RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p));

/** The Harbor project an app's images live in (spec section 3, image naming). */
export async function resolveNamespace(
  app: { owner_org_id: string | null; owner_address: string },
  orgs: Pick<RenownOrgs, "orgHandle" | "personHandle"> | null,
): Promise<string> {
  const usable = (h: string | null | undefined) => {
    const lower = h?.trim().toLowerCase() ?? "";
    return HARBOR_NAME.test(lower) && !isReserved(lower) ? lower : null;
  };
  if (app.owner_org_id) {
    const handle = usable(await orgs?.orgHandle(app.owner_org_id));
    return (
      handle ??
      `o-${app.owner_org_id
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
        .slice(0, 16)}`
    );
  }
  const handle = usable(await orgs?.personHandle(app.owner_address));
  return (
    handle ??
    `u-${app.owner_address.toLowerCase().replace(/^0x/, "").slice(0, 16)}`
  );
}

/** Who a namespace belongs to: the org for org apps, else the owner's address. */
export function namespaceOwner(app: {
  owner_org_id: string | null;
  owner_address: string;
}): { kind: "org" | "person"; id: string } {
  return app.owner_org_id
    ? { kind: "org", id: app.owner_org_id }
    : { kind: "person", id: app.owner_address.toLowerCase() };
}

/**
 * The app's namespace, fixed on first use (only a definitive Renown answer is
 * stored). The name is claimed in registry_namespaces first: a name another
 * owner holds (a handle released and re-taken, a person and an org sharing a
 * handle) is refused and nothing is stored on the app.
 */
export async function ensureAppNamespace(
  deps: AppsDeps,
  app: AppRow,
): Promise<string> {
  if (app.registry_namespace) return app.registry_namespace;
  // No Renown means no way to tell a missing handle from an unknown one:
  // never persist a fallback then. Lookup errors propagate for the same reason.
  if (!deps.orgs) throw notConfigured("Renown (orgs endpoint)");
  const ns = await resolveNamespace(app, deps.orgs);
  const owner = namespaceOwner(app);
  await deps.db
    .insertInto("registry_namespaces")
    .values({
      namespace: ns,
      owner_kind: owner.kind,
      owner_id: owner.id,
      created_at: deps.now().toISOString(),
    })
    .onConflict((oc) => oc.column("namespace").doNothing())
    .execute();
  const holder = await deps.db
    .selectFrom("registry_namespaces")
    .select(["owner_kind", "owner_id"])
    .where("namespace", "=", ns)
    .executeTakeFirstOrThrow();
  if (holder.owner_kind !== owner.kind || holder.owner_id !== owner.id)
    throw appsError(
      "FORBIDDEN",
      `The registry namespace ${ns} belongs to another owner; change the handle in Renown`,
    );
  await deps.db
    .updateTable("apps")
    .set({ registry_namespace: ns })
    .where("id", "=", app.id)
    .where("registry_namespace", "is", null)
    .execute();
  const row = await deps.db
    .selectFrom("apps")
    .select("registry_namespace")
    .where("id", "=", app.id)
    .executeTakeFirstOrThrow();
  return row.registry_namespace ?? ns;
}
