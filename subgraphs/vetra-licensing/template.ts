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
  setFusionConfig,
  setServiceVersion,
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
export const TEMPLATE_SERVICE_TYPES = [
  "CONNECT",
  "SWITCHBOARD",
  "FUSION",
] as const;
export type TemplateServiceType = (typeof TEMPLATE_SERVICE_TYPES)[number];

export interface TemplateService {
  id: string;
  /**
   * Widened to string on purpose: the document model's enum also carries CLINT,
   * which this slice refuses with UnsupportedTemplateServiceError.
   */
  type: string;
  prefix: string | null;
  /** The app image a FUSION service runs; null for every other type. */
  artifactName?: string | null;
  /** Which published version it follows: DEV, STAGING or LATEST. */
  artifactChannel?: string | null;
  /**
   * The concrete version the channel pointed at when this template was
   * resolved. Absent on an unresolved template; see artifact-resolution.ts for
   * why the hash must be taken over this rather than over the channel name.
   */
  resolvedVersion?: string | null;
  /** Filled by resolution: the image repository, without a tag. */
  resolvedRepository?: string | null;
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
export class UnresolvedFusionServiceError extends Error {
  override name = "UnresolvedFusionServiceError";
}
export class MultipleFusionServicesError extends Error {
  override name = "MultipleFusionServicesError";
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
  services: {
    type: TemplateServiceType;
    prefix: string;
    /** Set only for a FUSION service: the repository and tag to run. */
    repository?: string;
    version?: string;
  }[];
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
    return {
      name: p.packageName,
      version: p.version ?? DEFAULT_PACKAGE_VERSION,
    };
  });

  const services = t.services.map((s) => {
    const type = asServiceType(s.type);
    const base = { type, prefix: s.prefix ?? type.toLowerCase() };
    if (type !== "FUSION") return base;

    // An environment holds ONE fusion config, so a FUSION service without a
    // resolved image has nothing to run. Resolution happens before rendering
    // (artifact-resolution.ts); reaching here unresolved is a caller bug, and
    // rendering an empty image would deploy a broken environment.
    if (!s.resolvedRepository || !s.resolvedVersion) {
      throw new UnresolvedFusionServiceError(
        `FUSION service ${s.id} has no resolved image; resolve the template before rendering it`,
      );
    }
    return {
      ...base,
      repository: s.resolvedRepository,
      version: s.resolvedVersion,
    };
  });

  // The environment document stores a single `fusion` config, so two FUSION
  // services cannot both run. Refusing is honest; silently rendering one of
  // them would give the holder an environment nobody asked for.
  if (services.filter((s) => s.type === "FUSION").length > 1) {
    throw new MultipleFusionServicesError(
      "a template may carry at most one FUSION service — an environment runs one app image",
    );
  }

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
    actions.push(...fusionActions(s));
  }

  actions.push(approveChanges({}));
  return actions;
}

/**
 * The image half of a FUSION service. SET_FUSION_CONFIG takes the repository
 * only — it refuses a tag or digest — and the service's own version supplies
 * the tag, which is what the gitops renderer reads.
 *
 * autoUpdate is false on purpose: the licence template decides which version a
 * holder runs, and the keeper moves it by re-provisioning when the resolved
 * hash changes. Letting the environment chase tags on its own would make the
 * template's recorded version a lie.
 */
function fusionActions(s: NormalisedTemplate["services"][number]): Action[] {
  if (s.type !== "FUSION" || !s.repository || !s.version) return [];
  return [
    setFusionConfig({
      image: s.repository,
      env: [],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
    setServiceVersion({ type: "FUSION", version: s.version }),
  ];
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
 * Service types outside TEMPLATE_SERVICE_TYPES are left alone — a CLINT service
 * was enabled by something other than a licence template, and this renderer has
 * no mandate to tear it down. FUSION is now template-managed: a publisher who
 * drops the app image from a tier means holders should stop running it, and
 * these environments are only ever created from a template.
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
    // Emit the image only when it differs: re-stating it every tick would
    // churn the environment's revision for no change.
    if (s.type === "FUSION") {
      const sameImage = current.fusion?.image === s.repository;
      const sameVersion = have?.version === s.version;
      if (!sameImage || !sameVersion) actions.push(...fusionActions(s));
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

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Negative, zero or positive as prerelease `a` sorts before, with or after `b` (semver rules, simplified). */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1; // a release sorts after any prerelease of it
  if (b === undefined) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) {
      return -1;
    } else if (ny !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * True only when both are semver versions and `wanted` is newer. A dist-tag
 * (latest, dev) or anything else unparseable on either side is never an
 * upgrade: the floor never moves a package it cannot prove is older.
 */
export function isVersionUpgrade(current: string | null, wanted: string): boolean {
  if (current === null) return false;
  const c = SEMVER.exec(current);
  const w = SEMVER.exec(wanted);
  if (!c || !w) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(w[i]) - Number(c[i]);
    if (d !== 0) return d > 0;
  }
  return comparePrerelease(w[4], c[4]) > 0;
}

export interface FloorUpdateRenderInput {
  template: TemplateShape;
  /** The environment's current global state, as EnvGateway.getState returns it. */
  current: VetraCloudEnvironmentState;
}

/**
 * The action list that brings an existing, live environment UP TO a template,
 * treating the template as a floor: missing template packages are added,
 * template packages provably older than the template are upgraded, template
 * services that are missing or disabled are enabled, the FUSION image
 * follows the template (keeping the holder's env, secrets and auto-update
 * settings) and the FUSION version only ever moves up. Nothing is ever
 * removed, disabled or downgraded, and the label and service prefixes the
 * holder has are left alone. Returns []
 * when the environment already meets the floor, so nothing is dispatched.
 */
/**
 * The FUSION half of the floor. SET_FUSION_CONFIG replaces the whole fusion
 * config, so it is sent only when the image must change, and then carries the
 * holder's env (secret values live outside the document and are untouched),
 * autoUpdate and tag pattern over. The version moves only up, or is set when
 * the service has none (it was missing).
 */
function floorFusionActions(
  repository: string,
  version: string,
  have: VetraCloudEnvironmentState["services"][number] | undefined,
  fusion: VetraCloudEnvironmentState["fusion"],
): Action[] {
  const actions: Action[] = [];
  if (fusion?.image !== repository) {
    actions.push(
      setFusionConfig({
        image: repository,
        env: (fusion?.env ?? []).map((e) => ({
          name: e.name,
          value: e.value ?? null,
          isSecret: e.isSecret ?? null,
        })),
        autoUpdate: fusion?.autoUpdate ?? false,
        autoUpdateTagPattern: fusion?.autoUpdateTagPattern ?? null,
      }),
    );
  }
  const currentVersion = have?.version ?? null;
  if (currentVersion === null || isVersionUpgrade(currentVersion, version)) {
    actions.push(setServiceVersion({ type: "FUSION", version }));
  }
  return actions;
}

export function renderFloorUpdateActions(input: FloorUpdateRenderInput): Action[] {
  const n = validateTemplate(input.template);
  const current = input.current;
  const actions: Action[] = [];

  for (const p of n.packages) {
    const have = current.packages.find((c) => c.name === p.name);
    if (!have || isVersionUpgrade(have.version ?? null, p.version)) {
      actions.push(addPackage({ packageName: p.name, version: p.version }));
    }
  }
  for (const s of n.services) {
    const have = current.services.find((c) => c.type === s.type);
    if (!have || !have.enabled) {
      actions.push(enableService({ type: s.type, prefix: have?.prefix ?? s.prefix }));
    }
    if (s.type === "FUSION" && s.repository && s.version) {
      actions.push(...floorFusionActions(s.repository, s.version, have, current.fusion));
    }
  }

  if (actions.length > 0) actions.push(approveChanges({}));
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
    // `v` is the RESOLVED version, not the channel name. A template storing
    // dtbau-psb@LATEST is byte-identical before and after 1.3.0 publishes, so
    // hashing the channel would never move and no holder would be
    // re-provisioned onto the new image. See artifact-resolution.ts.
    services: [...t.services]
      .map((s) => ({
        t: s.type,
        p: s.prefix ?? null,
        a: s.artifactName ?? null,
        c: s.artifactChannel ?? null,
        v: s.resolvedVersion ?? null,
      }))
      .sort(
        (a, b) =>
          a.t.localeCompare(b.t) ||
          (a.p ?? "").localeCompare(b.p ?? "") ||
          (a.a ?? "").localeCompare(b.a ?? ""),
      ),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
