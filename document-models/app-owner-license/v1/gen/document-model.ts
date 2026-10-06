import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "powerhouse/app-owner-license",
  name: "AppOwnerLicense",
  author: {
    name: "Powerhouse Inc.",
    website: "https://www.powerhouse.inc",
  },
  extension: "lic",
  description:
    "A license granting a user an app, with its validity window and lifecycle status.",
  specifications: [
    {
      version: 1,
      changeLog: [],
      state: {
        global: {
          schema:
            "type AppOwnerLicenseState {\n  app: PHID\n  licenseType: PHID\n  user: EthereumAddress\n  issuer: LicenseIssuerKind\n  issuedBy: EthereumAddress\n  stage: PHID\n  details: String\n  issued: DateTime\n  start: DateTime\n  end: DateTime\n  status: LicenseStatus!\n  replacedBy: PHID\n  revokedReason: String\n}\n\nenum LicenseIssuerKind {\n  INVITE_CODE\n  PUBLISHER_GRANT\n  ACHRA_SUBSCRIPTION\n}\n\nenum LicenseStatus {\n  ISSUED\n  ACTIVE\n  EXPIRED\n  REVOKED\n  REPLACED\n}",
          initialValue:
            '{\n  "app": null,\n  "licenseType": null,\n  "user": null,\n  "issuer": null,\n  "issuedBy": null,\n  "stage": null,\n  "details": null,\n  "issued": null,\n  "start": null,\n  "end": null,\n  "status": "ISSUED",\n  "replacedBy": null,\n  "revokedReason": null\n}',
          examples: [],
        },
        local: {
          schema: "",
          initialValue: "",
          examples: [],
        },
      },
      modules: [
        {
          id: "lic-mod-001",
          name: "lifecycle",
          description: "",
          operations: [
            {
              id: "op-issue-license",
              name: "ISSUE_LICENSE",
              description:
                "Issue a license. Dates are resolved by the caller because reducers are pure.",
              schema:
                "input IssueLicenseInput {\n  app: PHID!\n  licenseType: PHID!\n  user: EthereumAddress!\n  issuer: LicenseIssuerKind!\n  issuedBy: EthereumAddress!\n  stage: PHID\n  details: String\n  issued: DateTime!\n  start: DateTime!\n  end: DateTime\n}",
              template: "",
              reducer:
                'if (state.user) {\n  throw new AlreadyIssuedError("this license is already issued");\n}\nif (action.input.end && action.input.end < action.input.start) {\n  throw new EndBeforeStartError("end must not precede start");\n}\nstate.app = action.input.app;\nstate.licenseType = action.input.licenseType;\nstate.user = action.input.user.toLowerCase();\nstate.issuer = action.input.issuer;\nstate.issuedBy = action.input.issuedBy.toLowerCase();\nstate.stage = action.input.stage ?? null;\nstate.details = action.input.details ?? null;\nstate.issued = action.input.issued;\nstate.start = action.input.start;\nstate.end = action.input.end ?? null;\nstate.status = "ISSUED";',
              errors: [
                {
                  id: "err-already-issued",
                  name: "AlreadyIssuedError",
                  code: "ALREADY_ISSUED",
                  description: "This license has already been issued",
                  template: "",
                },
                {
                  id: "err-end-before-start",
                  name: "EndBeforeStartError",
                  code: "END_BEFORE_START",
                  description: "The end date precedes the start date",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-activate-license",
              name: "ACTIVATE_LICENSE",
              description: "Move the license from ISSUED to ACTIVE.",
              schema: "input ActivateLicenseInput {\n  _: Boolean\n}",
              template: "",
              reducer:
                'if (state.status !== "ISSUED") {\n  throw new InvalidStatusTransitionError(\n    `cannot activate a license with status ${state.status}`,\n  );\n}\nstate.status = "ACTIVE";',
              errors: [
                {
                  id: "err-invalid-transition-activate",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The license status does not permit this transition",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-expire-license",
              name: "EXPIRE_LICENSE",
              description:
                "Expire an ISSUED or ACTIVE license. ISSUED to EXPIRED is deliberate: it avoids provisioning an environment only to tear it down.",
              schema: "input ExpireLicenseInput {\n  _: Boolean\n}",
              template: "",
              reducer:
                'if (state.status !== "ISSUED" && state.status !== "ACTIVE") {\n  throw new InvalidStatusTransitionError(\n    `cannot expire a license with status ${state.status}`,\n  );\n}\nstate.status = "EXPIRED";',
              errors: [
                {
                  id: "err-invalid-transition-expire",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The license status does not permit this transition",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-revoke-license",
              name: "REVOKE_LICENSE",
              description:
                "Revoke an ISSUED or ACTIVE license, recording a reason.",
              schema: "input RevokeLicenseInput {\n  reason: String\n}",
              template: "",
              reducer:
                'if (state.status !== "ISSUED" && state.status !== "ACTIVE") {\n  throw new InvalidStatusTransitionError(\n    `cannot revoke a license with status ${state.status}`,\n  );\n}\nstate.status = "REVOKED";\nstate.revokedReason = action.input.reason ?? null;',
              errors: [
                {
                  id: "err-invalid-transition-revoke",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The license status does not permit this transition",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-replace-license",
              name: "REPLACE_LICENSE",
              description: "Mark an ACTIVE license as replaced by another.",
              schema: "input ReplaceLicenseInput {\n  replacedBy: PHID!\n}",
              template: "",
              reducer:
                'if (state.status !== "ACTIVE") {\n  throw new InvalidStatusTransitionError(\n    `cannot replace a license with status ${state.status}`,\n  );\n}\nstate.status = "REPLACED";\nstate.replacedBy = action.input.replacedBy;',
              errors: [
                {
                  id: "err-invalid-transition-replace",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The license status does not permit this transition",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
    },
  ],
};
