import { INSTANCE_BASE_DOMAIN } from "./reconciler.js";
import type { InstanceRow } from "./repo.js";

/** The fields the public host reads; the custom domain columns arrive with plan 7 Task 7. */
export type PublicHostFields = Pick<InstanceRow, "host"> & {
  custom_domain?: string | null;
  custom_domain_status?: string | null;
};

/** The host a person opens: the custom domain once active, else the generated host. */
export const publicHostOf = (r: PublicHostFields): string | null =>
  r.custom_domain && r.custom_domain_status === "active"
    ? r.custom_domain
    : r.host
      ? `${r.host}.${INSTANCE_BASE_DOMAIN}`
      : null;

export const publicUrlOf = (r: PublicHostFields): string | null => {
  const host = publicHostOf(r);
  return host ? `https://${host}` : null;
};
