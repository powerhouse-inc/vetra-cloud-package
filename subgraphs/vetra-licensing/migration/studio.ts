import type { Action } from "document-model";
import { actions as appActions } from "document-models/vetra-app";
import type { AppDocView } from "../app-reads.js";
import { STUDIO_APP_ID } from "../studio-app.js";

/** The one studio app id (studio-app.ts); never a second definition. */
export { STUDIO_APP_ID };

export const STUDIO_APP_NAME = "Vetra Studio";
export const STUDIO_TEMPLATE_ID = "studio";
export const STUDIO_TEMPLATE_NAME = "Studio early access";
export const STUDIO_TERM_ID = "studio-early-access-30d";
export const STUDIO_KIND = "studio-early-access-30d";
export const STUDIO_TERM_LABEL = "Studio early access (30 days)";
export const STUDIO_VALIDITY_DAYS = 30;

/** What the studio app document must hold besides its (empty) artifacts. */
export interface StudioReconcilePlan {
  actions: Action[];
  /** Human-readable, one entry per difference: what gets changed or removed. */
  changes: string[];
}

/**
 * The SHARED template studio licences resolve to. SHARED provisions nothing,
 * so studio environments are never adopted, provisioned or offboarded.
 */
function isExpectedTemplate(t: AppDocView["templates"][number]): boolean {
  return (
    t.id === STUDIO_TEMPLATE_ID &&
    t.name === STUDIO_TEMPLATE_NAME &&
    t.mode === "SHARED" &&
    t.sharedEnvironment === null &&
    t.template.services.length === 0 &&
    t.template.packages.length === 0 &&
    t.template.size === null &&
    t.template.baseDomain === null &&
    t.template.packageRegistry === null
  );
}

function isExpectedTerm(t: AppDocView["terms"][number]): boolean {
  return (
    t.id === STUDIO_TERM_ID &&
    t.kind === STUDIO_KIND &&
    t.label === STUDIO_TERM_LABEL &&
    t.templateId === STUDIO_TEMPLATE_ID &&
    t.validityDays === STUDIO_VALIDITY_DAYS &&
    t.issuers.length === 1 &&
    t.issuers[0] === "INVITE_CODE" &&
    t.status === "ACTIVE"
  );
}

/**
 * The actions that make an app document EXACTLY the studio app: its details,
 * one SHARED template and one ACTIVE term. Anything else in templates or
 * terms is foreign and deleted (a document at the public STUDIO_APP_ID may
 * have been written by anyone before Vetra created it); its content is never
 * adopted. `view` null: a freshly created, empty document.
 *
 * Artifacts are not removed (no operation does that); a SHARED template never
 * reads them. The caller logs them.
 */
export function studioReconcilePlan(
  view: AppDocView | null,
  cfg: { slug: string; publisher: string },
): StudioReconcilePlan {
  const actions: Action[] = [];
  const changes: string[] = [];
  const name = view?.name ?? null;
  const slug = view?.slug ?? null;
  const owner = view?.owner?.toLowerCase() ?? null;
  if (name !== STUDIO_APP_NAME || slug !== cfg.slug || owner !== cfg.publisher) {
    actions.push(appActions.setAppDetails({ name: STUDIO_APP_NAME, slug: cfg.slug, owner: cfg.publisher }));
    if (view) changes.push(`details ${JSON.stringify({ name, slug, owner })}`);
  }
  if (view?.status !== "ACTIVE") {
    actions.push(appActions.setStatus({ status: "ACTIVE" }));
    if (view) changes.push(`status ${view.status}`);
  }
  // A SHARED term's stage is the template's shared environment, else the
  // app's production environment: the studio has neither.
  if (view?.productionEnvironmentId) {
    actions.push(appActions.setProductionEnvironment({ environmentId: null }));
    changes.push(`production environment ${view.productionEnvironmentId}`);
  }
  if (view?.identityDid) {
    actions.push(appActions.setIdentity({ did: null, expiresAt: null }));
    changes.push(`identity ${view.identityDid}`);
  }

  const terms = view?.terms ?? [];
  const templates = view?.templates ?? [];
  const templateOk = templates.some(isExpectedTemplate);
  // A term is kept only with its template intact: otherwise the template is
  // replaced, which it cannot be while a term points at it.
  const termOk = (t: AppDocView["terms"][number]) => templateOk && isExpectedTerm(t);
  // Terms first: a template a term points at cannot be deleted.
  for (const t of terms.filter((x) => !termOk(x))) {
    actions.push(appActions.deleteTerm({ id: t.id }));
    changes.push(`term ${t.id} (${t.kind}, ${t.status})`);
  }
  for (const t of templates.filter((x) => !isExpectedTemplate(x))) {
    actions.push(appActions.deleteTemplate({ id: t.id }));
    changes.push(`template ${t.id} (${t.mode})`);
  }
  if (!templateOk) {
    actions.push(appActions.addTemplate({ id: STUDIO_TEMPLATE_ID, name: STUDIO_TEMPLATE_NAME, mode: "SHARED" }));
  }
  if (!terms.some(termOk)) {
    actions.push(
      appActions.addTerm({
        id: STUDIO_TERM_ID,
        kind: STUDIO_KIND,
        label: STUDIO_TERM_LABEL,
        templateId: STUDIO_TEMPLATE_ID,
        validityDays: STUDIO_VALIDITY_DAYS,
        issuers: ["INVITE_CODE"],
      }),
      appActions.publishTerm({ id: STUDIO_TERM_ID }),
    );
  }
  return { actions, changes };
}
