/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AppLicenseTypeState,
  AutoUpdateChannel,
  EnvironmentTemplate,
  LicenseTypeStatus,
  PublishLicenseTypeInput,
  RemoveTemplatePackageInput,
  RemoveTemplateServiceInput,
  RetireLicenseTypeInput,
  SetLicenseTypeDetailsInput,
  SetTemplateInput,
  TemplatePackage,
  TemplateService,
  TemplateServiceType,
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

export const AutoUpdateChannelSchema = z.enum(["DEV", "LATEST", "STAGING"]);

export const LicenseTypeStatusSchema = z.enum(["ACTIVE", "DRAFT", "RETIRED"]);

export const TemplateServiceTypeSchema = z.enum([
  "CLINT",
  "CONNECT",
  "DOCLING",
  "FUSION",
  "PAPERLESS",
  "SPECKLE",
  "SWITCHBOARD",
]);

export function AddTemplatePackageInputSchema(): z.ZodObject<
  Properties<AddTemplatePackageInput>
> {
  return z.object({
    id: z.string(),
    packageName: z.string().nullish(),
    version: z.string().nullish(),
  });
}

export function AddTemplateServiceInputSchema(): z.ZodObject<
  Properties<AddTemplateServiceInput>
> {
  return z.object({
    artifactChannel: AutoUpdateChannelSchema.nullish(),
    artifactName: z.string().nullish(),
    id: z.string(),
    prefix: z.string().nullish(),
    type: TemplateServiceTypeSchema,
  });
}

export function AppLicenseTypeStateSchema(): z.ZodObject<
  Properties<AppLicenseTypeState>
> {
  return z.object({
    __typename: z.literal("AppLicenseTypeState").optional(),
    app: z.string().nullish(),
    kind: z.string().nullish(),
    label: z.string().nullish(),
    status: LicenseTypeStatusSchema,
    template: z.lazy(() => EnvironmentTemplateSchema().nullish()),
    validityDays: z.number().nullish(),
  });
}

export function EnvironmentTemplateSchema(): z.ZodObject<
  Properties<EnvironmentTemplate>
> {
  return z.object({
    __typename: z.literal("EnvironmentTemplate").optional(),
    baseDomain: z.string().nullish(),
    packageRegistry: z.url().nullish(),
    packages: z.array(z.lazy(() => TemplatePackageSchema())),
    services: z.array(z.lazy(() => TemplateServiceSchema())),
    size: z.string().nullish(),
  });
}

export function PublishLicenseTypeInputSchema(): z.ZodObject<
  Properties<PublishLicenseTypeInput>
> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function RemoveTemplatePackageInputSchema(): z.ZodObject<
  Properties<RemoveTemplatePackageInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function RemoveTemplateServiceInputSchema(): z.ZodObject<
  Properties<RemoveTemplateServiceInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function RetireLicenseTypeInputSchema(): z.ZodObject<
  Properties<RetireLicenseTypeInput>
> {
  return z.object({
    _: z.boolean().nullish(),
  });
}

export function SetLicenseTypeDetailsInputSchema(): z.ZodObject<
  Properties<SetLicenseTypeDetailsInput>
> {
  return z.object({
    app: z.string().nullish(),
    kind: z.string().nullish(),
    label: z.string().nullish(),
    validityDays: z.number().nullish(),
  });
}

export function SetTemplateInputSchema(): z.ZodObject<
  Properties<SetTemplateInput>
> {
  return z.object({
    baseDomain: z.string().nullish(),
    packageRegistry: z.url().nullish(),
    size: z.string().nullish(),
  });
}

export function TemplatePackageSchema(): z.ZodObject<
  Properties<TemplatePackage>
> {
  return z.object({
    __typename: z.literal("TemplatePackage").optional(),
    id: z.string(),
    packageName: z.string().nullish(),
    version: z.string().nullish(),
  });
}

export function TemplateServiceSchema(): z.ZodObject<
  Properties<TemplateService>
> {
  return z.object({
    __typename: z.literal("TemplateService").optional(),
    artifactChannel: AutoUpdateChannelSchema.nullish(),
    artifactName: z.string().nullish(),
    id: z.string(),
    prefix: z.string().nullish(),
    type: TemplateServiceTypeSchema,
  });
}
