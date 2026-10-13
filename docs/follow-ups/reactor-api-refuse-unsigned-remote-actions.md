# reactor-api: refuse remote actions without a user signer

**Repository:** powerhouse (`packages/reactor-api`)
**Requested by:** Vetra (vetra-cloud-package, Renown organisations C1)
**Closes:** spec §8.1 residuals (a) and (b) in `renown-package/docs/superpowers/specs/2026-10-12-renown-organisations-design.md`

## Problem

Document reducers distinguish *user* actions (`action.context.signer.user` set, signature verified) from *system* actions (no user signer). System actions are meant to come only from the server's own in-process reactor client (jobs, subgraphs), so reducers trust them. For example, the `vetra-cloud-environment` reducers skip every owner check (`assertOwner`) for an action without a user signer.

reactor-api does not enforce that distinction for remote callers. `mutateDocument` / `pushSyncEnvelopes` (GraphQL and sync) admit an action when the caller may write the document (`assertCanWrite`) and execute the operation (`assertCanExecuteOperation`). Whether the action itself carries a user signer is not checked. Any authenticated caller with WRITE on a document, or ADMIN, or an operation grant can therefore submit an **unsigned** action. The reducer then treats it as system.

## Threat

- **Personal environments.** The owner (document ADMIN) can push unsigned "system" actions to their own env: `SET_APP_LINK` to another app's Harbor project, `SET_OWNER`, `SET_OWNER_ORG` (Vetra reverts it), and status reports (`MARK_*`, `REPORT_DEPLOYMENT_*`).
- **Organisation environments.** Every operator (WRITE grant) can push unsigned actions of every operation that is not restricted. This bypasses `orgOperators` signer attribution, so the actions do not record who made them.
- **Fresh documents.** Between document creation and the asynchronous protection hook, which takes milliseconds, anyone allowed to write the drive can push an unsigned `SET_OWNER` and take the env.
- Vetra's mitigations narrow these paths but cannot close them, because they all sit downstream of admission:
  - restricting the system-only operations to document admins;
  - moving org envs to a service identity nobody signs as;
  - reverting unannounced organisation moves;
  - purging foreign grants.

## Proposed change

1. In the remote write paths (`mutateDocument`, `mutateDocumentAsync`, `pushSyncEnvelopes`, and any other resolver that accepts actions from a client), reject every action whose `context.signer.user.address` is missing. Reject with a `FORBIDDEN`-class error such as `UNSIGNED_ACTION`. The in-process reactor client (`reactorClient.execute` from subgraphs and processors) is not affected.
2. Require the signer address to equal the authenticated caller, compared case-insensitively. This already holds when the signature is verified against the bearer's DID. Make it explicit, so that a caller cannot replay someone else's signed action as their own submission.
3. Allow an opt-out per document type or per operation (`allowUnsignedRemote`) for models that truly need anonymous writes. The default is to refuse.
4. Global admins (`ADMINS`) may keep submitting unsigned actions, behind a configuration flag that defaults to off. This allows operational repair.

## Acceptance tests

- A caller with WRITE on a protected document submits an action without `context.signer`. The action is refused with `UNSIGNED_ACTION`, no operation is appended, and the state is unchanged.
- The same caller submits the same action signed by their own key. It is accepted.
- The caller submits an action signed by a different address than the authenticated one. It is refused.
- A document ADMIN or protection owner submits an unsigned action, including one on a restricted operation. It is refused.
- The holder of an operation grant submits that operation unsigned. It is refused.
- `pushSyncEnvelopes` with a mix of signed and unsigned actions refuses the whole envelope (or each unsigned action, if the API allows partial results). Either way, nothing unsigned is applied.
- The in-process `reactorClient.execute` with an unsigned action still works. Vetra's jobs depend on this.
- A model or operation with `allowUnsignedRemote` still accepts unsigned remote actions.
- With the admin flag on, a global admin's unsigned action is accepted. With the flag off, it is refused.

## Rollout notes

- Before enabling, audit clients that push unsigned actions remotely: Connect drive sync and any scripts. Connect signs user actions when a Renown session is present. Anonymous Connect use against protected documents already fails at admission.
- Once deployed on the Vetra tenants, Vetra can drop the revert-unannounced-move path for new documents. It keeps the path for legacy documents.
