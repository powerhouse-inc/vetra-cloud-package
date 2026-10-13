/**
 * Process-wide hook through which other subgraphs ask vetra-apps to adopt the
 * Apps Renown lists as a person's own (e.g. transferred out of an
 * organisation to them) before listing that person's Apps. vetra-apps
 * registers it at setup; until then (or without vetra-apps) it does nothing.
 * Never throws: a failed adoption leaves the rows as they are.
 */
type Adopter = (address: string) => Promise<void>;

let adopter: Adopter | null = null;

export function setPersonAppAdopter(fn: Adopter | null): void {
  adopter = fn;
}

export async function adoptPersonAppsViaVetraApps(address: string): Promise<void> {
  if (!adopter) return;
  try {
    await adopter(address);
  } catch (err) {
    console.warn(`[person-app-adoption] ${address}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
