import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";

export function createResolvers(
  _db: Kysely<VetraLicensingDB>,
): Record<string, unknown> {
  return {
    Query: {
      vetraLicensing: () => ({}),
    },
    VetraLicensingQueries: {
      _placeholder: () => true,
    },
  };
}
