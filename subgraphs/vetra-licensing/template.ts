import { createHash } from "node:crypto";
import type { Action } from "document-model";
import {
  setLabel,
  initialize,
  setOwner,
  addPackage,
  removePackage,
  enableService,
  disableService,
  approveChanges,
  type VetraCloudEnvironmentState,
  type VetraCloudRessourceSize,
} from "document-models/vetra-cloud-environment";

/**
 * The service types a slice-1 template may ask for. CLINT is deliberately
 * absent: enabling a CLINT service requires a `clintConfig` (package, env,
 * command) that the template document cannot yet express, and the environment
 * reducer rejects a CLINT service without one. Rendering refuses such a
 * template up front rather than failing at the reducer.
 */
export const TEMPLATE_SERVICE_TYPES = ["CONNECT", "SWITCHBOARD"] as const;
export type TemplateServiceType = (typeof TEMPLATE_SERVICE_TYPES)[number];

export interface TemplateService {
  id: string;
  /**
   * Widened to string on purpose: the document model's enum also carries CLINT,
   * which this slice refuses with UnsupportedTemplateServiceError.
   */
  type: string;
  prefix: string | null;
}

export interface TemplatePackage {
  id: string;
  packageName: string | null;
  version: string | null;
}

export interface TemplateShape {
  services: TemplateService[];
  packages: TemplatePackage[];
  /**
   * Resource size for a CLINT service. INERT in this slice: only CLINT services
   * carry `selectedRessource`, and CLINT templates are refused, so nothing
   * consumes this. It is still validated (a typo must not pass silently) and
   * still part of the hash, so the field is ready when CLINT lands.
   */
  size: string | null;
  baseDomain: string | null;
  packageRegistry: string | null;
}

const DEFAULT_BASE_DOMAIN = "vetra.io";

/** What `addPackageOperation` stores when an action carries no version. */
const DEFAULT_PACKAGE_VERSION = "latest";

const RESOURCE_SIZES: readonly VetraCloudRessourceSize[] = [
  "VETRA_AGENT_S",
  "VETRA_AGENT_M",
  "VETRA_AGENT_L",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
];

export class UnknownTemplateSizeError extends Error {
  override name = "UnknownTemplateSizeError";
}
export class UnsupportedTemplateServiceError extends Error {
  override name = "UnsupportedTemplateServiceError";
}
export class MissingPackageNameError extends Error {
  override name = "MissingPackageNameError";
}

/** null means "no resource size"; any other unrecognised value is an error. */
function asResourceSize(size: string | null): VetraCloudRessourceSize | null {
  if (size === null) return null;
  const found = RESOURCE_SIZES.find((s) => s === size);
  if (!found) {
    throw new UnknownTemplateSizeError(
      `unknown template size "${size}" — expected one of ${RESOURCE_SIZES.join(", ")}`,
    );
  }
  return found;
}

function asServiceType(type: string): TemplateServiceType {
  const found = TEMPLATE_SERVICE_TYPES.find((t) => t === type);
  if (!found) {
    const extra =
      type === "CLINT"
        ? " — a CLINT service needs a clintConfig the template cannot carry yet"
        : "";
    throw new UnsupportedTemplateServiceError(
      `template service type "${type}" is not supported in this slice${extra}; expected one of ${TEMPLATE_SERVICE_TYPES.join(", ")}`,
    );
  }
  return found;
}

/** A template reduced to exactly what the environment document stores. */
export interface NormalisedTemplate {
  services: { type: TemplateServiceType; prefix: string }[];
  packages: { name: string; version: string }[];
}

/**
 * Pure. Rejects anything this slice cannot render. Call it before creating any
 * document, so a malformed template cannot leak an environment on every tick.
 */
export function validateTemplate(t: TemplateShape): NormalisedTemplate {
  asResourceSize(t.size);

  const packages = t.packages.map((p) => {
    if (!p.packageName) {
      throw new MissingPackageNameError(
        `template package ${p.id} has no packageName`,
      );
    }
    return { name: p.packageName, version: p.version ?? DEFAULT_PACKAGE_VERSION };
  });

  const services = t.services.map((s) => {
    const type = asServiceType(s.type);
    return { type, prefix: s.prefix ?? type.toLowerCase() };
  });

  return { services, packages };
}

export interface CreateRenderInput {
  label: string;
  subdomain: string;
  owner: string;
  template: TemplateShape;
}

/**
 * The action list that builds a brand-new environment, as every environment in
 * this repo is built (see subgraphs/vetra-apps/service.ts, createApp).
 * Order matters: initialize before owner, packages before services, approval
 * last. INITIALIZE and SET_OWNER are create-only — the reducers reject both on
 * an environment that already exists — so they live here and nowhere else.
 */
export function renderCreateActions(input: CreateRenderInput): Action[] {
  const t = input.template;
  const n = validateTemplate(t);

  const actions: Action[] = [
    setLabel({ label: input.label }),
    initialize({
      genericSubdomain: input.subdomain,
      genericBaseDomain: t.baseDomain ?? DEFAULT_BASE_DOMAIN,
      defaultPackageRegistry: t.packageRegistry ?? undefined,
    }),
    setOwner({ address: input.owner }),
  ];

  for (const p of n.packages) {
    actions.push(addPackage({ packageName: p.name, version: p.version }));
  }
  for (const s of n.services) {
    actions.push(enableService({ type: s.type, prefix: s.prefix }));
  }

  actions.push(approveChanges({}));
  return actions;
}

export interface UpdateRenderInput {
  label: string;
  template: TemplateShape;
  /** The environment's current global state, as EnvGateway.getState returns it. */
  current: VetraCloudEnvironmentState;
}

/**
 * The action list that reconciles an existing environment onto the template.
 * It emits only the difference, in both directions: a package or service the
 * publisher dropped from the licence type is removed, not left running.
 *
 * Service types outside TEMPLATE_SERVICE_TYPES are left alone — a FUSION or
 * CLINT service was enabled by something other than a licence template, and
 * this renderer has no mandate to tear it down.
 */
export function renderUpdateActions(input: UpdateRenderInput): Action[] {
  const n = validateTemplate(input.template);
  const current = input.current;

  const actions: Action[] = [setLabel({ label: input.label })];

  const currentPackages = current.packages;
  for (const p of n.packages) {
    const have = currentPackages.find((c) => c.name === p.name);
    // ADD_PACKAGE doubles as "set to this version" when the package is present.
    if (!have || have.version !== p.version) {
      actions.push(addPackage({ packageName: p.name, version: p.version }));
    }
  }
  for (const c of currentPackages) {
    if (!n.packages.some((p) => p.name === c.name)) {
      actions.push(removePackage({ packageName: c.name }));
    }
  }

  const currentServices = current.services;
  for (const s of n.services) {
    // Non-CLINT services are singletons keyed by type, so a prefix change is an
    // update of the same entry rather than a second service.
    const have = currentServices.find((c) => c.type === s.type);
    if (!have || !have.enabled || have.prefix !== s.prefix) {
      actions.push(enableService({ type: s.type, prefix: s.prefix }));
    }
  }
  for (const c of currentServices) {
    if (!c.enabled) continue;
    if (!TEMPLATE_SERVICE_TYPES.some((t) => t === c.type)) continue;
    if (!n.services.some((s) => s.type === c.type)) {
      actions.push(disableService({ type: c.type, prefix: c.prefix }));
    }
  }

  actions.push(approveChanges({}));
  return actions;
}

/**
 * sha256 over a canonical form. Used to recognise an environment whose
 * template has changed since it was provisioned; never for security.
 *
 * Both sorts are total: services tie-break on prefix and packages on version,
 * so two same-type services or two versions of one package cannot hash
 * differently depending on the order the document happened to list them in.
 */
export function templateHash(t: TemplateShape): string {
  const canonical = JSON.stringify({
    baseDomain: t.baseDomain ?? null,
    packageRegistry: t.packageRegistry ?? null,
    size: t.size ?? null,
    packages: [...t.packages]
      .map((p) => ({ n: p.packageName ?? null, v: p.version ?? null }))
      .sort(
        (a, b) =>
          (a.n ?? "").localeCompare(b.n ?? "") ||
          (a.v ?? "").localeCompare(b.v ?? ""),
      ),
    services: [...t.services]
      .map((s) => ({ t: s.type, p: s.prefix ?? null }))
      .sort(
        (a, b) =>
          a.t.localeCompare(b.t) || (a.p ?? "").localeCompare(b.p ?? ""),
      ),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
