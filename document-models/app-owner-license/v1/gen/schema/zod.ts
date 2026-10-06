/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  ActivateLicenseInput,
  AppOwnerLicenseState,
  ExpireLicenseInput,
  IssueLicenseInput,
  LicenseIssuerKind,
  LicenseStatus,
  ReplaceLicenseInput,
  RevokeLicenseInput,
} from "./types.js";

type Properties<T> = Required<{
  [K in keyof T]: z.ZodType<T[K]>;
}>;

type definedNonNullAny = {};

export const isDefinedNonNullAny = (v: any): v is definedNonNullAny =>
  v !== undefined && v !== null;

export const definedNonNullAnySchema = z
  .any()
  .refine((v) => isDefinedNonNullAny(v));

export const LicenseIssuerKindSchema = z.enum([
  "ACHRA_SUBSCRIPTION",
  "INVITE_CODE",
  "PUBLISHER_GRANT",
]);

export const LicenseStatusSchema = z.enum([
  "ACTIVE",
  "EXPIRED",
  "ISSUED",
  "REPLACED",
  "REVOKED",
]);

export function ActivateLicenseInputSchema(): z.ZodObject<
  Properties<ActivateLicenseInput>
> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function AppOwnerLicenseStateSchema(): z.ZodObject<
  Properties<AppOwnerLicenseState>
> {
  return z.object({
    __typename: z.literal("AppOwnerLicenseState").optional(),
    app: z.string().nullish(),
    details: z.string().nullish(),
    end: z.iso.datetime().nullish(),
    issued: z.iso.datetime().nullish(),
    issuedBy: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      })
      .nullish(),
    issuer: LicenseIssuerKindSchema.nullish(),
    licenseType: z.string().nullish(),
    replacedBy: z.string().nullish(),
    revokedReason: z.string().nullish(),
    stage: z.string().nullish(),
    start: z.iso.datetime().nullish(),
    status: LicenseStatusSchema,
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      })
      .nullish(),
  });
}

export function ExpireLicenseInputSchema(): z.ZodObject<
  Properties<ExpireLicenseInput>
> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function IssueLicenseInputSchema(): z.ZodObject<
  Properties<IssueLicenseInput>
> {
  return z.object({
    app: z.string(),
    details: z.string().nullish(),
    end: z.iso.datetime().nullish(),
    issued: z.iso.datetime(),
    issuedBy: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      }),
    issuer: LicenseIssuerKindSchema,
    licenseType: z.string(),
    stage: z.string().nullish(),
    start: z.iso.datetime(),
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      }),
  });
}

export function ReplaceLicenseInputSchema(): z.ZodObject<
  Properties<ReplaceLicenseInput>
> {
  return z.object({
    replacedBy: z.string(),
  });
}

export function RevokeLicenseInputSchema(): z.ZodObject<
  Properties<RevokeLicenseInput>
> {
  return z.object({
    reason: z.string().nullish(),
  });
}
