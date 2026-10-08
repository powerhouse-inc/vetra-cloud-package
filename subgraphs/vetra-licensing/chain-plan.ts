import type { LicenseStatusName } from "./transitions.js";
import type { TemplateMode } from "./app-reads.js";

export interface PlanLicence {
  id: string;
  user: string;
  kind: string | null;
  status: LicenseStatusName;
  issued: string | null;
  stage: string | null;
  /** Chain root: the licence itself unless it upgraded/renewed another. */
  root: string;
  /** Has an app_license_grants row. Without one it provisions and releases nothing. */
  authorised: boolean;
}

export type PlanResolution =
  | { ok: true; mode: TemplateMode; templateId: string; templateHash: string; sharedStage: string | null; label: string }
  | { ok: false; reason: string };

export interface PlanEnvironment {
  environmentId: string;
  rootLicenseId: string;
  licenseId: string;
  templateHash: string;
  endedAt: string | null;
}

/** Integrity of the app document the licences belong to (AppDocView). */
export interface PlanApp {
  tampered: boolean;
  tamperReason: string | null;
  unverified: boolean;
}

export type ChainStep =
  | { kind: "provision"; root: string; licence: PlanLicence; templateId: string; templateHash: string; label: string; environmentId: string | null }
  | { kind: "set-stage"; licenseId: string; stage: string }
  | { kind: "hold"; root: string; reason: string }
  | { kind: "ended"; root: string; environmentId: string }
  | { kind: "resumed"; root: string; environmentId: string };

const TERMINAL: ReadonlySet<LicenseStatusName> = new Set(["EXPIRED", "REVOKED", "REPLACED"]);

/** Newest first: later `issued` (missing = oldest), then the larger id. Total and input-order independent. */
const newestFirst = (a: PlanLicence, b: PlanLicence) =>
  (b.issued ?? "").localeCompare(a.issued ?? "") || b.id.localeCompare(a.id);

/** Why the whole app is held, or null when its chains may be planned. */
function appHold(app: PlanApp | undefined, holdUnverified: boolean): string | null {
  if (!app) return null;
  if (app.tampered) return `app is tampered (${app.tamperReason ?? "unknown"}): holding`;
  if (app.unverified && holdUnverified) return "app licensing state is unverified (no ledger row): holding";
  return null;
}

/**
 * Pure. One environment per licence chain. A chain is served by its newest
 * authorised ACTIVE licence (the head); a chain holding two ACTIVE licences
 * (a replace that failed after its issue succeeded) is still ONE chain with
 * ONE environment. A chain is ENDED only when every licence in it is terminal
 * (EXPIRED, REVOKED, REPLACED); anything unknown — an unresolvable kind, a
 * missing provenance row, an unreadable chain, a licence not yet active, a
 * tampered (or, when asked, unverified) app — is HELD. Holding is the only
 * answer to doubt.
 *
 * `app` is the integrity of the app document; `holdUnverified` holds an app
 * with no ledger row (the caller sets it once the migration has seeded the
 * ledger).
 */
export function planChains(input: {
  licences: PlanLicence[];
  environments: PlanEnvironment[];
  resolve(kind: string | null): PlanResolution;
  app?: PlanApp;
  holdUnverified?: boolean;
}): ChainStep[] {
  const byRoot = new Map<string, PlanLicence[]>();
  for (const l of input.licences) {
    const list = byRoot.get(l.root) ?? [];
    list.push(l);
    byRoot.set(l.root, list);
  }
  const envsByRoot = new Map<string, PlanEnvironment[]>();
  for (const e of input.environments) {
    const list = envsByRoot.get(e.rootLicenseId) ?? [];
    list.push(e);
    envsByRoot.set(e.rootLicenseId, list);
  }
  const roots = [...new Set([...byRoot.keys(), ...envsByRoot.keys()])].sort();
  const heldApp = appHold(input.app, input.holdUnverified ?? false);

  const steps: ChainStep[] = [];
  for (const root of roots) {
    const chain = byRoot.get(root) ?? [];
    const envs = envsByRoot.get(root) ?? [];

    if (heldApp) {
      // Nothing would be done for a fully terminal chain without an environment.
      if (envs.length > 0 || chain.some((l) => !TERMINAL.has(l.status))) {
        steps.push({ kind: "hold", root, reason: heldApp });
      }
      continue;
    }
    if (envs.length > 1) {
      const ids = envs.map((e) => e.environmentId).sort().join(", ");
      steps.push({ kind: "hold", root, reason: `chain owns more than one environment (${ids})` });
      continue;
    }
    const env: PlanEnvironment | null = envs.length === 1 ? envs[0] : null;

    if (chain.length === 0) {
      if (env) steps.push({ kind: "hold", root, reason: "no licence of this chain could be read" });
      continue;
    }

    const heads = chain.filter((l) => l.status === "ACTIVE" && l.authorised).sort(newestFirst);
    const head: PlanLicence | null = heads.length > 0 ? heads[0] : null;
    if (!head) {
      if (!env) continue;
      if (chain.some((l) => l.status === "ACTIVE")) {
        steps.push({ kind: "hold", root, reason: "ACTIVE licence without provenance" });
      } else if (chain.some((l) => !TERMINAL.has(l.status))) {
        steps.push({ kind: "hold", root, reason: "licence issued but not yet active" });
      } else if (env.endedAt === null) {
        steps.push({ kind: "ended", root, environmentId: env.environmentId });
      }
      continue;
    }

    const r = input.resolve(head.kind);
    if (!r.ok) {
      steps.push({ kind: "hold", root, reason: r.reason });
      continue;
    }

    if (r.mode === "SHARED") {
      if (env) {
        steps.push({ kind: "hold", root, reason: "chain owns a DEDICATED environment but its head now resolves to SHARED" });
        continue;
      }
      if (r.sharedStage && head.stage !== r.sharedStage) {
        steps.push({ kind: "set-stage", licenseId: head.id, stage: r.sharedStage });
      }
      continue;
    }

    if (env && env.endedAt !== null) {
      steps.push({ kind: "resumed", root, environmentId: env.environmentId });
    }
    if (!env || env.licenseId !== head.id || env.templateHash !== r.templateHash) {
      steps.push({
        kind: "provision",
        root,
        licence: head,
        templateId: r.templateId,
        templateHash: r.templateHash,
        label: r.label,
        environmentId: env?.environmentId ?? null,
      });
    } else if (head.stage !== env.environmentId) {
      steps.push({ kind: "set-stage", licenseId: head.id, stage: env.environmentId });
    }
  }
  return steps;
}
