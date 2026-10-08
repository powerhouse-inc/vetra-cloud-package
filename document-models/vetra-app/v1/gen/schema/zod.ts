/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddTemplateInput,
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AddTermInput,
  AutoUpdateChannel,
  ConnectRepositoryInput,
  DeleteTemplateInput,
  LicenseIssuerKind,
  LicenseTermStatus,
  PublishTermInput,
  RecordArtifactVersionInput,
  RemoveTemplatePackageInput,
  RemoveTemplateServiceInput,
  RetireTermInput,
  SetAppDetailsInput,
  SetArtifactChannelInput,
  SetIdentityInput,
  SetPreviewsInput,
  SetProductionEnvironmentInput,
  SetStatusInput,
  SetTemplateDetailsInput,
  SetTermDetailsInput,
  TemplateInstanceMode,
  TemplatePackage,
  TemplateService,
  TemplateServiceType,
  VetraAppArtifact,
  VetraAppArtifactChannel,
  VetraAppArtifactKind,
  VetraAppArtifactVersion,
  VetraAppEnvironmentTemplate,
  VetraAppIdentity,
  VetraAppLicenseTerm,
  VetraAppPreviews,
  VetraAppRepository,
  VetraAppState,
  VetraAppStatus,
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

export const LicenseIssuerKindSchema = z.enum([
  "ACHRA_SUBSCRIPTION",
  "INVITE_CODE",
  "PUBLISHER_GRANT",
]);

export const LicenseTermStatusSchema = z.enum(["ACTIVE", "DRAFT", "RETIRED"]);

export const TemplateInstanceModeSchema = z.enum(["DEDICATED", "SHARED"]);

export const TemplateServiceTypeSchema = z.enum([
  "CLINT",
  "CONNECT",
  "DOCLING",
  "FUSION",
  "PAPERLESS",
  "SPECKLE",
  "SWITCHBOARD",
]);

export const VetraAppArtifactKindSchema = z.enum(["FUSION_IMAGE", "PACKAGE"]);

export const VetraAppStatusSchema = z.enum([
  "ACTIVE",
  "DELETED",
  "DISCONNECTED",
  "PENDING_IDENTITY",
]);

export function AddTemplateInputSchema(): z.ZodObject<
  Properties<AddTemplateInput>
> {
  return z.object({
    id: z.string(),
    mode: TemplateInstanceModeSchema,
    name: z.string().nullish(),
  });
}

export function AddTemplatePackageInputSchema(): z.ZodObject<
  Properties<AddTemplatePackageInput>
> {
  return z.object({
    id: z.string(),
    packageName: z.string(),
    templateId: z.string(),
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
    templateId: z.string(),
    type: TemplateServiceTypeSchema,
  });
}

export function AddTermInputSchema(): z.ZodObject<Properties<AddTermInput>> {
  return z.object({
    id: z.string(),
    issuers: z.array(LicenseIssuerKindSchema).nullish(),
    kind: z.string(),
    label: z.string().nullish(),
    templateId: z.string().nullish(),
    validityDays: z.number().nullish(),
  });
}

export function ConnectRepositoryInputSchema(): z.ZodObject<
  Properties<ConnectRepositoryInput>
> {
  return z.object({
    fullName: z.string().nullish(),
    productionBranch: z.string().nullish(),
    repositoryId: z.string().nullish(),
  });
}

export function DeleteTemplateInputSchema(): z.ZodObject<
  Properties<DeleteTemplateInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function PublishTermInputSchema(): z.ZodObject<
  Properties<PublishTermInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function RecordArtifactVersionInputSchema(): z.ZodObject<
  Properties<RecordArtifactVersionInput>
> {
  return z.object({
    commitSha: z.string().nullish(),
    kind: VetraAppArtifactKindSchema,
    name: z.string(),
    publishedAt: z.iso.datetime(),
    reference: z.string(),
    runId: z.string().nullish(),
    version: z.string(),
  });
}

export function RemoveTemplatePackageInputSchema(): z.ZodObject<
  Properties<RemoveTemplatePackageInput>
> {
  return z.object({
    id: z.string(),
    templateId: z.string(),
  });
}

export function RemoveTemplateServiceInputSchema(): z.ZodObject<
  Properties<RemoveTemplateServiceInput>
> {
  return z.object({
    id: z.string(),
    templateId: z.string(),
  });
}

export function RetireTermInputSchema(): z.ZodObject<
  Properties<RetireTermInput>
> {
  return z.object({
    id: z.string(),
  });
}

export function SetAppDetailsInputSchema(): z.ZodObject<
  Properties<SetAppDetailsInput>
> {
  return z.object({
    name: z.string().nullish(),
    owner: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      })
      .nullish(),
    slug: z.string().nullish(),
  });
}

export function SetArtifactChannelInputSchema(): z.ZodObject<
  Properties<SetArtifactChannelInput>
> {
  return z.object({
    channel: AutoUpdateChannelSchema,
    kind: VetraAppArtifactKindSchema,
    name: z.string(),
    version: z.string(),
  });
}

export function SetIdentityInputSchema(): z.ZodObject<
  Properties<SetIdentityInput>
> {
  return z.object({
    did: z.string().nullish(),
    expiresAt: z.iso.datetime().nullish(),
  });
}

export function SetPreviewsInputSchema(): z.ZodObject<
  Properties<SetPreviewsInput>
> {
  return z.object({
    enabled: z.boolean(),
    limit: z.number(),
    ttlDays: z.number(),
  });
}

export function SetProductionEnvironmentInputSchema(): z.ZodObject<
  Properties<SetProductionEnvironmentInput>
> {
  return z.object({
    environmentId: z.string().nullish(),
  });
}

export function SetStatusInputSchema(): z.ZodObject<
  Properties<SetStatusInput>
> {
  return z.object({
    status: VetraAppStatusSchema,
  });
}

export function SetTemplateDetailsInputSchema(): z.ZodObject<
  Properties<SetTemplateDetailsInput>
> {
  return z.object({
    baseDomain: z.string().nullish(),
    id: z.string(),
    mode: TemplateInstanceModeSchema.nullish(),
    name: z.string().nullish(),
    packageRegistry: z.url().nullish(),
    sharedEnvironment: z.string().nullish(),
    size: z.string().nullish(),
  });
}

export function SetTermDetailsInputSchema(): z.ZodObject<
  Properties<SetTermDetailsInput>
> {
  return z.object({
    id: z.string(),
    issuers: z.array(LicenseIssuerKindSchema).nullish(),
    kind: z.string().nullish(),
    label: z.string().nullish(),
    templateId: z.string().nullish(),
    validityDays: z.number().nullish(),
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

export function VetraAppArtifactSchema(): z.ZodObject<
  Properties<VetraAppArtifact>
> {
  return z.object({
    __typename: z.literal("VetraAppArtifact").optional(),
    channels: z.array(z.lazy(() => VetraAppArtifactChannelSchema())),
    id: z.string(),
    kind: VetraAppArtifactKindSchema,
    name: z.string(),
    versions: z.array(z.lazy(() => VetraAppArtifactVersionSchema())),
  });
}

export function VetraAppArtifactChannelSchema(): z.ZodObject<
  Properties<VetraAppArtifactChannel>
> {
  return z.object({
    __typename: z.literal("VetraAppArtifactChannel").optional(),
    channel: AutoUpdateChannelSchema,
    version: z.string(),
  });
}

export function VetraAppArtifactVersionSchema(): z.ZodObject<
  Properties<VetraAppArtifactVersion>
> {
  return z.object({
    __typename: z.literal("VetraAppArtifactVersion").optional(),
    commitSha: z.string().nullish(),
    publishedAt: z.iso.datetime(),
    reference: z.string(),
    runId: z.string().nullish(),
    version: z.string(),
  });
}

export function VetraAppEnvironmentTemplateSchema(): z.ZodObject<
  Properties<VetraAppEnvironmentTemplate>
> {
  return z.object({
    __typename: z.literal("VetraAppEnvironmentTemplate").optional(),
    baseDomain: z.string().nullish(),
    id: z.string(),
    mode: TemplateInstanceModeSchema,
    name: z.string().nullish(),
    packageRegistry: z.url().nullish(),
    packages: z.array(z.lazy(() => TemplatePackageSchema())),
    services: z.array(z.lazy(() => TemplateServiceSchema())),
    sharedEnvironment: z.string().nullish(),
    size: z.string().nullish(),
  });
}

export function VetraAppIdentitySchema(): z.ZodObject<
  Properties<VetraAppIdentity>
> {
  return z.object({
    __typename: z.literal("VetraAppIdentity").optional(),
    did: z.string().nullish(),
    expiresAt: z.iso.datetime().nullish(),
  });
}

export function VetraAppLicenseTermSchema(): z.ZodObject<
  Properties<VetraAppLicenseTerm>
> {
  return z.object({
    __typename: z.literal("VetraAppLicenseTerm").optional(),
    id: z.string(),
    issuers: z.array(LicenseIssuerKindSchema),
    kind: z.string(),
    label: z.string().nullish(),
    status: LicenseTermStatusSchema,
    templateId: z.string().nullish(),
    validityDays: z.number().nullish(),
  });
}

export function VetraAppPreviewsSchema(): z.ZodObject<
  Properties<VetraAppPreviews>
> {
  return z.object({
    __typename: z.literal("VetraAppPreviews").optional(),
    enabled: z.boolean(),
    limit: z.number(),
    ttlDays: z.number(),
  });
}

export function VetraAppRepositorySchema(): z.ZodObject<
  Properties<VetraAppRepository>
> {
  return z.object({
    __typename: z.literal("VetraAppRepository").optional(),
    fullName: z.string().nullish(),
    productionBranch: z.string().nullish(),
    repositoryId: z.string().nullish(),
  });
}

export function VetraAppStateSchema(): z.ZodObject<Properties<VetraAppState>> {
  return z.object({
    __typename: z.literal("VetraAppState").optional(),
    artifacts: z.array(z.lazy(() => VetraAppArtifactSchema())),
    identity: z.lazy(() => VetraAppIdentitySchema().nullish()),
    name: z.string().nullish(),
    owner: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      })
      .nullish(),
    previews: z.lazy(() => VetraAppPreviewsSchema().nullish()),
    productionEnvironmentId: z.string().nullish(),
    repository: z.lazy(() => VetraAppRepositorySchema().nullish()),
    slug: z.string().nullish(),
    status: VetraAppStatusSchema,
    templates: z.array(z.lazy(() => VetraAppEnvironmentTemplateSchema())),
    terms: z.array(z.lazy(() => VetraAppLicenseTermSchema())),
  });
}
