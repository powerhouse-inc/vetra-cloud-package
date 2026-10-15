/** The package a freshly-provisioned Vetra Studio installs as its CLINT agent. */
export const STUDIO_AGENT_PACKAGE = "vetra";

/** Package names that mark an env as a studio — includes the pre-rename `vetra-cli`. */
export const STUDIO_AGENT_PACKAGE_NAMES: readonly string[] = ["vetra", "vetra-cli"];

/** Whether `name` identifies the studio CLINT agent package (either name). */
export function isStudioAgentPackage(name: string | null | undefined): boolean {
  return !!name && STUDIO_AGENT_PACKAGE_NAMES.includes(name);
}

/** Whether an environment document's state installs the studio agent package (the document is the truth, not the projection). */
export function isStudioState(state: { packages: ReadonlyArray<{ name: string }> } | null | undefined): boolean {
  return !!state && state.packages.some((p) => isStudioAgentPackage(p.name));
}
