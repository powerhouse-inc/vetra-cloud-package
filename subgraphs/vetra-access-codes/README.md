# vetra-access-codes

Operations guide for the early-access invite-code subgraph: who can manage
codes, what they can do, and what must be configured to keep it secure. This is
for the **DevOps** owner of the deployment and the **admins** who hand out and
revoke access. No code changes are needed for day-to-day operation.

A code grants its redeemer 30 days of access. Codes can be multi-use, expiring,
and capped to a number of redemptions.

---

## DevOps — required configuration

Admin access is enforced by the Switchboard gateway, not by this subgraph's
code. On the deployment that serves it, these must be set:

| Setting | Value | Why |
| ------- | ----- | --- |
| `AUTH_ENABLED` | `true` | If unset/false, **every caller is treated as admin** — no protection. |
| `ADMINS` | comma-separated, lowercased wallet addresses | The admin allowlist. |
| `SKIP_CREDENTIAL_VERIFICATION` | **unset** | If set, anyone can forge a token for any address, including an admin's. |

To add or remove an admin, edit `ADMINS` and redeploy — no code change.

The public web app must point at this deployment's GraphQL endpoint
(`NEXT_PUBLIC_CLOUD_SWITCHBOARD_URL`) and the canonical Renown host
(`NEXT_PUBLIC_RENOWN_URL`, e.g. `https://www.renown.id` — the apex `renown.id`
redirects and breaks login).

**Rate limiting:** the code-validity check is public and unauthenticated. Keep
the proxy/ingress rate limit in front of `/graphql` so codes can't be guessed
by brute force.

---

## Admins — getting an access token

Every management action needs an admin **bearer token** from a wallet listed in
`ADMINS`. Two ways to get one:

- **CLI:** `ph login` (once, to authenticate your wallet), then `ph access-token`
  — copy the printed token.
- **Browser console** (while logged in to the app with that wallet):
  ```js
  await window.ph.renown.getBearerToken({ expiresIn: 600 })
  ```

Use the token either way:

- **Apollo Playground** — open `<deployment>/graphql`, and under **Headers** add:
  ```json
  { "Authorization": "Bearer <token>" }
  ```
  then run the operations below.
- **curl** — pass `-H "Authorization: Bearer <token>"`.

---

## Admins — what you can do

| Action | Operation |
| ------ | --------- |
| Create a code | `createInviteCode(code, label, expiresAt, maxUses)` |
| List codes + redemption counts | `inviteCodes` |
| See if/what a wallet redeemed | `redemptions(address)` (or `redemptions(code)`) |
| Stop new redemptions of a code | `setInviteCodeActive(code, false)` |
| Remove a wallet's current access | `revokeAccess(address)` |

All operations are namespaced under `VetraAccessCodes`. Examples (run in the
Playground, or via curl against `<deployment>/graphql`):

```graphql
# create a code
mutation { VetraAccessCodes { createInviteCode(code: "cohort-2", label: "Cohort 2", maxUses: 200) { code active } } }

# list codes with how many times each was redeemed
query { VetraAccessCodes { inviteCodes { code label active maxUses redemptions } } }

# has this wallet used a code? (matches the address on any chain)
query { VetraAccessCodes { redemptions(address: "0x…") { code redeemedAt accessExpires } } }

# disable a code — blocks NEW redemptions, does not revoke existing access
mutation { VetraAccessCodes { setInviteCodeActive(code: "cohort-2", active: false) { code active } } }

# remove a wallet's current access (returns how many grants were revoked)
mutation { VetraAccessCodes { revokeAccess(address: "0x…") } }
```

`address` must be a full `0x` + 40-hex wallet address.

---

## Admins — operational notes

- **Disable vs. revoke.** `setInviteCodeActive(code, false)` only stops *new*
  redemptions; wallets that already redeemed keep their access. To remove an
  individual's access, use `revokeAccess(address)`.
- **Revoke is not a permanent ban.** It expires the wallet's current grants. If
  another code is still active, that wallet could redeem it and regain access —
  to fully lock someone out, also disable the codes they could use.
- **Access expires after 30 days** per redemption. Re-entering the same code
  does not extend it.
