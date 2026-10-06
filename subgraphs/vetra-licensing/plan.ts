export interface ActiveLicense {
  licenseId: string;
  user: string;
  licenseTypeId: string;
  templateHash: string;
}

export interface UserEnvironment {
  user: string;
  environmentId: string;
  templateHash: string;
}

export interface LicensePlan {
  toApply: ActiveLicense[];
  toRelease: string[];
}

/**
 * Pure. Desired state from licences, actual state from environments, diffed.
 *
 * A user may hold more than one active licence (spec open question 1). Until a
 * real precedence rule is decided, the lowest licence id wins — chosen because
 * it is stable: the same input produces the same plan on every tick, whatever
 * order the rows arrive in.
 *
 * Both sides are keyed on the lowercased address. Licences come from documents
 * and environments from a table that stores the address lowercased; a
 * checksummed address on one side only would make every tick both release the
 * live environment and create a fresh one. The invariant is enforced here
 * rather than assumed of the caller.
 */
export function computeLicensePlan(
  licenses: ActiveLicense[],
  environments: UserEnvironment[],
): LicensePlan {
  const key = (user: string) => user.toLowerCase();

  const desired = new Map<string, ActiveLicense>();
  for (const l of licenses) {
    const held = desired.get(key(l.user));
    if (!held || l.licenseId < held.licenseId) {
      desired.set(key(l.user), l);
    }
  }

  const actual = new Map(environments.map((e) => [key(e.user), e]));

  const toApply = [...desired.values()]
    .filter((l) => {
      const env = actual.get(key(l.user));
      return !env || env.templateHash !== l.templateHash;
    })
    .sort((a, b) => a.licenseId.localeCompare(b.licenseId));

  const toRelease = environments
    .filter((e) => !desired.has(key(e.user)))
    .map((e) => e.environmentId)
    .sort((a, b) => a.localeCompare(b));

  return { toApply, toRelease };
}
