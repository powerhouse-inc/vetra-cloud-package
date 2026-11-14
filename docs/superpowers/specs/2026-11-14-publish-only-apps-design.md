# Publish-only apps — design

Date: 2026-11-14. Status: draft for review.
Builds on: [app releases and instances](2026-11-11-app-releases-and-instances-design.md)
(its section 16 removes the deploy path for GitHub apps; this is the first
step of that, for new apps).

## 1. Why

Creating an app still follows the old deploy path: the wizard asks for a
**production environment** ("Create a new environment" or "Use an existing
environment"), and `createApp` always creates or attaches one. Under the
release model that is backwards. A publisher connects a repository, publishes
releases, and only then decides how anyone runs them: the Team plan for the
org's own people, plans and invite codes for users. An environment at
creation is a leftover that also hands every new app free hosting.

## 2. What changes

Creating an app connects the repository and nothing more:

1. **The wizard has no environment step.** "Configure your app" asks for the
   app name and the production branch (the branch releases are cut from), then
   **Create app**. The "Production environment" section (new / existing) is
   removed. The last step is renamed "Set up publishing" and says: merge the
   setup pull request and every push publishes.
2. **`createApp` never creates an environment.** It still reserves the Harbor
   project, creates the push robot and the Renown identity, and records the
   app. `apps.production_environment_id` stays null.
3. **The generated workflow has only the vetra-publish job** for an app with
   no production environment. The old `deploy` job (vetra-deploy-action on the
   production branch and pull requests) is left out.
4. **An app with no production environment is publish-only.** No separate flag:
   a null `production_environment_id` is the only marker, so the two can never
   disagree.

After creating the app, the publisher's path is the one the console checklist
already shows: authorize the identity, merge the setup PR, publish a release,
then optionally turn on the **Team plan** (spec 2026-11-11, section 5) and
create plans and invite codes.

## 3. What does not change

- **Existing apps** (Sektar and every app created before this) keep their
  production environment, previews and the old deploy path, until section 16
  of the releases spec removes them.
- **Vetra Studio** apps (`createStudioApp`) keep creating their environment
  (Studio is out of scope, releases spec section 9).
- **The API keeps `productionEnvironmentId` on `createApp`** as an explicit
  attach of an existing environment. The console no longer sends it. Without
  it, no environment is created (this is the breaking change; the console is
  the only caller).

## 4. Backend (vetra-cloud-package)

### Data

One migration: `apps.production_environment_id` drops `NOT NULL`
(`ALTER COLUMN … DROP NOT NULL`, idempotent, safe while every existing row has
a value). The Kysely type becomes `string | null`.

### Every reader of the production environment

Each place below gets the null case. One test per row, against an app with no
production environment.

| Where | With no production environment |
|---|---|
| `createApp` (`service.ts`, "creating/provisioning the production environment") | skipped; nothing to undo on failure |
| `deployApp`, `ciDeployApp`, `rollbackApp` and the deploy helpers (`service.ts`) | refused: `BAD_USER_INPUT` "This app publishes releases; it has no deploy environment" |
| PR previews (`service.ts`, webhook `pull_request`) | skipped silently (no preview, no PR comment) |
| Watcher, app removal (`watcher.ts`, `service.ts` delete) | the environment step is skipped |
| Org transfer (`org-ownership.ts`) | the environment is skipped |
| Setup PR (`workflowTemplate`, `service.ts` setup and re-setup) | workflow without the `deploy` job |
| App URLs (`resolvers.ts`) | none |
| App document mirror (`app-document.ts`) | already nullable; unchanged |
| Licensing `appEnvironments` (`vetra-licensing/index.ts`) | null filtered out (today it would return `[null]`) |
| Licensing app reads and publisher resolvers | already handle null; unchanged |
| Image project resolver (`app-image-project.ts`) | no match; unchanged |

### GraphQL

`App.productionEnvironmentId: String!` becomes `String`. No type is added or
renamed, so the gateway composition is unaffected; after the pin the gateway
check runs anyway (`Excluding subgraph` in the log, licensing still queryable).

## 5. Console (vetra.to)

- **Wizard** (`new-app-wizard.tsx`): the environment section and the
  environment list query go; `createApp` is called without
  `productionEnvironmentId`. Step 3 is "Set up publishing".
- **App page**: for an app with no production environment the Production card
  and the Deployments tab are hidden. Overview, Releases, Rollouts, Plans,
  Invite codes, Profile and Settings stay. The setup checklist (already
  release-based) is unchanged.
- **Types**: `App.productionEnvironmentId` is `string | null`; the environment
  link on the overview only renders with an id.

## 6. Rollout

1. vetra-cloud-package PR (migration, guards, workflow, schema), tests green,
   published, pinned on **staging**.
2. vetra.to PR (wizard, app page), deployed to staging.
3. Staging rehearsal: create an app from a test repository without an
   environment, merge the setup PR, see a build and a release, turn on a plan,
   create an invite code. Check that an existing app still deploys.
4. Pin on production, gateway check, console to production.

Order is safe either way: a new console against an old backend gets an
environment created as before; an old console against a new backend still sends
an environment choice, which attaches or (for "new") creates nothing.

## 7. Testing

- Backend: PGlite tests for `createApp` without an environment (no env
  document, null column, Harbor and identity created), each guard in the table
  in section 4, `workflowTemplate` without the deploy job, licensing
  `appEnvironments` without null.
- Console: wizard renders no environment section and calls `createApp` without
  an environment; app page hides Production and Deployments for an app without
  an environment.

## 8. Out of scope

Removing the deploy path for existing apps (releases spec section 16), a
publisher's own `main` instance (releases spec phase 2), Studio apps.
