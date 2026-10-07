# Licensing product model — evaluation and target design

**Status:** evaluation complete; implementation partial (see Delivery status).
**Date:** 2026-10-07

## The product, as the publisher describes it

An app publisher owns several repositories: **packages** (published to the
registry), **fusion apps** (a Dockerfile), and a **landing page** (a Dockerfile).
They connect those repos and create an App in Vetra, declaring which registry
packages the app uses, which Dockerfile is the fusion app, and which is the
landing page. Some apps additionally need services such as **docling**.

The publisher then defines **licence types**, each carrying a **template** — the
shape of the environment a holder gets:

- Connect, with the packages installed
- Switchboard, with the packages installed
- both, plus the fusion app

Granting a licence to a user entitles them to that template. Two delivery modes
exist in the real products:

- **Dedicated** — the holder gets their own instance. *Knowledge Vault*: fusion
  app + switchboard with the package installed, one environment per holder.
- **Shared** — all holders use one deployment. *pfnuer*: every toll-collect
  operator registers on a single app deployment.

The **landing page is promotional only and is never part of a template.**

## What exists today

| Capability | State |
|---|---|
| Connect repos, create an App, build images | Works (`vetra-apps`) |
| Registry packages in a template | Works (`TemplatePackage`) |
| Licence types, grant, revoke, publisher dashboard | Works (`vetra-licensing`, `/user/publisher`) |
| Keeper turns active licences into environments | Works, **disabled in production** |
| Fusion app in a template | **Missing** |
| docling / paperless / speckle in a template | **Missing** |
| Shared vs dedicated delivery | **Missing** — always dedicated |
| Landing page excluded from templates | Correct by construction |

## Gap 1 — a template cannot express what an environment can run

The two enums disagree:

- `vetra-cloud-environment` provisions `CONNECT, SWITCHBOARD, FUSION, CLINT,
  DOCLING, PAPERLESS, SPECKLE`
- `app-license-type` licenses only `CONNECT, SWITCHBOARD, CLINT`

So the Knowledge Vault template — fusion app + switchboard — **cannot be
expressed as a licence type at all**, nor can docling. The publisher dashboard
offered `FUSION` regardless; because the licence model rejects it, the reducer
threw a raw schema error. That symptom was fixed by removing FUSION from the
picker, which was right for the model as it stood and wrong for the product.

**Target:** `TemplateServiceType` carries every service an environment can
actually run. The licence model is the narrower of the two only where a service
is deliberately not licensable, and that must be a decision, not a drift.

## Gap 2 — delivery mode is not modelled

`computeLicensePlan` is keyed entirely on `user`: desired state is one
environment per holder, and `toRelease` deletes environments whose user is no
longer entitled. There is no way to say "these holders share one deployment", so
the pfnuer shape is unrepresentable — it would provision one environment per
operator.

The environment document has a single `owner: EthereumAddress` and **no members
list**, so shared access cannot be expressed on the environment either.

**Target:** `instanceMode: DEDICATED | SHARED` on the licence type's template.

- `DEDICATED` — today's behaviour, keyed on holder.
- `SHARED` — the keeper provisions **one** environment per licence type, owned
  by the app owner. Every holder's licence row cites that environment id.
  Entitlement is answered by "is there an ACTIVE licence for this user and this
  type", not by environment ownership — so the environment document needs no
  members list, and revoking a holder must **not** release the shared
  environment. The shared environment is released only when the licence type is
  retired and no ACTIVE licence of that type remains.

This is the invasive change: `plan.ts` must plan per `(type, mode)` rather than
per user, and `toRelease` must never delete a shared environment on the strength
of one holder leaving. That is the same code path that makes the production gate
dangerous, so the two should land together.

## Gap 3 — the keeper trusts unauthenticated documents (production blocker)

`allLicenses()` scans **every** `powerhouse/app-owner-license` document in the
reactor and treats each as an entitlement, keyed on the `app` the document
declares. Nothing proves the document was created by that app's owner.

Legitimate licences are created by `license-gateway.ts` **system-signed** (no
user signer), so a forged document is *indistinguishable by provenance* — there
is no signer to check. Creating one requires an authenticated wallet, which
bounded the risk on team-only staging; in production it does not.

The exposure is worse than unauthorised provisioning. Because `toRelease`
deletes environments whose user is absent from the desired set, influence over
the document set is influence over **deletion** of real customers'
environments.

**Target:** entitlement is a server-side record, not a document. `issueGrant`
and `revokeLicense` already authorise through `resolveOwnerApp`; they should
also write the authoritative row. The keeper reads licence documents only for
their state and **ignores any licence without a matching authorised row for that
app**. A forged document then provisions nothing and releases nothing.

Until that lands, `LICENSING_KEEPER_ENABLED` stays unset in production. It gates
both the keeper and every publisher mutation, so the dashboard is read-only
there.

## Delivery status

- **Gap 1** — implemented in this change set.
- **Gap 3** — specified here; not implemented. It is the production gate.
- **Gap 2** — specified here; not implemented. Largest change; should land with
  Gap 3 because both rewrite the release path.

## Decisions taken without the publisher present

- Shared environments are owned by the **app owner**, not by an arbitrary
  holder, so that no holder's departure can orphan or delete them.
- Entitlement for shared mode is derived from licence rows rather than added to
  the environment document, because adding a members list would change a model
  that three products already depend on.
- The landing page stays outside the template, as stated.
