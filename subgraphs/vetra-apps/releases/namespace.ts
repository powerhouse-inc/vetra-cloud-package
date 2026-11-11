import type { RenownOrgs } from "../../../shared/renown-orgs.js";
import type { AppsDeps } from "../service.js";
import type { AppRow } from "../repo.js";

const HARBOR_NAME = /^[a-z0-9][a-z0-9._-]{1,254}$/;

/** The Harbor project an app's images live in (spec section 3, image naming). */
export async function resolveNamespace(
  app: { owner_org_id: string | null; owner_address: string },
  orgs: Pick<RenownOrgs, "orgHandle" | "personHandle"> | null,
): Promise<string> {
  const usable = (h: string | null | undefined) => {
    const lower = h?.trim().toLowerCase() ?? "";
    return HARBOR_NAME.test(lower) ? lower : null;
  };
  if (app.owner_org_id) {
    const handle = usable(await orgs?.orgHandle(app.owner_org_id).catch(() => null));
    return handle ?? `o-${app.owner_org_id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8)}`;
  }
  const handle = usable(await orgs?.personHandle(app.owner_address).catch(() => null));
  return handle ?? `u-${app.owner_address.toLowerCase().replace(/^0x/, "").slice(0, 8)}`;
}

/** The app's namespace, fixed on first use. */
export async function ensureAppNamespace(deps: AppsDeps, app: AppRow): Promise<string> {
  if (app.registry_namespace) return app.registry_namespace;
  const ns = await resolveNamespace(app, deps.orgs ?? null);
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
