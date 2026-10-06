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
 */
export function computeLicensePlan(
  licenses: ActiveLicense[],
  environments: UserEnvironment[],
): LicensePlan {
  const desired = new Map<string, ActiveLicense>();
  for (const l of licenses) {
    const held = desired.get(l.user);
    if (!held || l.licenseId < held.licenseId) {
      desired.set(l.user, l);
    }
  }

  const actual = new Map(environments.map((e) => [e.user, e]));

  const toApply = [...desired.values()].filter((l) => {
    const env = actual.get(l.user);
    return !env || env.templateHash !== l.templateHash;
  });

  const toRelease = environments
    .filter((e) => !desired.has(e.user))
    .map((e) => e.environmentId);

  return { toApply, toRelease };
}
