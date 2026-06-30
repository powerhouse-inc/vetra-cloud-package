/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddPackageInput,
  ApproveChangesInput,
  ArchiveInput,
  AutoUpdateChannel,
  DisableServiceInput,
  DnsRecord,
  DnsRecordInput,
  EnableServiceInput,
  InitializeInput,
  MarkChangesPushedInput,
  MarkDeploymentStartedInput,
  MarkDestroyedInput,
  RemovePackageInput,
  ReportDeploymentFailedInput,
  ReportDeploymentSucceededInput,
  ServiceStatus,
  SetApexServiceInput,
  SetAutoUpdateChannelInput,
  SetCustomDomainInput,
  SetDefaultPackageRegistryInput,
  SetDnsRecordsInput,
  SetGenericSubdomainInput,
  SetLabelInput,
  SetOwnerInput,
  SetPackageVersionInput,
  SetRuntimeConfigInput,
  SetServiceConfigInput,
  SetServiceSizeInput,
  SetServiceStatusInput,
  SetServiceVersionInput,
  SleepEnvironmentInput,
  TerminateEnvironmentInput,
  ToggleServiceInput,
  UnarchiveInput,
  UpdateServicePrefixInput,
  VetraCloudEnvironmentService,
  VetraCloudEnvironmentServiceType,
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentStatus,
  VetraCloudPackage,
  VetraCloudPackageConfigInput,
  VetraCloudPackageInput,
  VetraCloudRessourceSize,
  VetraCloudServiceClint,
  VetraCloudServiceClintConfigInput,
  VetraCloudServiceClintInput,
  VetraCloudServiceEnv,
  VetraCloudServiceEnvConfigInput,
  VetraCloudServiceEnvInput,
  VetraCustomDomain,
  WakeEnvironmentInput,
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

export const ServiceStatusSchema = z.enum([
  "ACTIVE",
  "BILLING_ISSUE",
  "PROVISIONING",
  "SUSPENDED",
]);

export const VetraCloudEnvironmentServiceTypeSchema = z.enum([
  "CLINT",
  "CONNECT",
  "FUSION",
  "SWITCHBOARD",
]);

export const VetraCloudEnvironmentStatusSchema = z.enum([
  "ARCHIVED",
  "CHANGES_APPROVED",
  "CHANGES_PENDING",
  "CHANGES_PUSHED",
  "DEPLOYING",
  "DEPLOYMENt_FAILED",
  "DESTROYED",
  "DRAFT",
  "READY",
  "STOPPED",
  "TERMINATING",
]);

export const VetraCloudRessourceSizeSchema = z.enum([
  "VETRA_AGENT_L",
  "VETRA_AGENT_M",
  "VETRA_AGENT_S",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
]);

export function AddPackageInputSchema(): z.ZodObject<
  Properties<AddPackageInput>
> {
  return z.object({
    packageName: z.string(),
    registry: z.url().nullish(),
    version: z.string().nullish(),
  });
}

export function ApproveChangesInputSchema(): z.ZodObject<
  Properties<ApproveChangesInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function ArchiveInputSchema(): z.ZodObject<Properties<ArchiveInput>> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function DisableServiceInputSchema(): z.ZodObject<
  Properties<DisableServiceInput>
> {
  return z.object({
    prefix: z.string().nullish(),
    type: VetraCloudEnvironmentServiceTypeSchema,
  });
}

export function DnsRecordSchema(): z.ZodObject<Properties<DnsRecord>> {
  return z.object({
    __typename: z.literal("DnsRecord").optional(),
    host: z.string(),
    type: z.string(),
    value: z.string(),
  });
}

export function DnsRecordInputSchema(): z.ZodObject<
  Properties<DnsRecordInput>
> {
  return z.object({
    host: z.string(),
    type: z.string(),
    value: z.string(),
  });
}

export function EnableServiceInputSchema(): z.ZodObject<
  Properties<EnableServiceInput>
> {
  return z.object({
    clintConfig: z.lazy(() => VetraCloudServiceClintInputSchema().nullish()),
    prefix: z.string(),
    selectedRessource: VetraCloudRessourceSizeSchema.nullish(),
    type: VetraCloudEnvironmentServiceTypeSchema,
  });
}

export function InitializeInputSchema(): z.ZodObject<
  Properties<InitializeInput>
> {
  return z.object({
    defaultPackageRegistry: z.url().nullish(),
    genericBaseDomain: z.string(),
    genericSubdomain: z.string(),
  });
}

export function MarkChangesPushedInputSchema(): z.ZodObject<
  Properties<MarkChangesPushedInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function MarkDeploymentStartedInputSchema(): z.ZodObject<
  Properties<MarkDeploymentStartedInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function MarkDestroyedInputSchema(): z.ZodObject<
  Properties<MarkDestroyedInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function RemovePackageInputSchema(): z.ZodObject<
  Properties<RemovePackageInput>
> {
  return z.object({
    packageName: z.string(),
  });
}

export function ReportDeploymentFailedInputSchema(): z.ZodObject<
  Properties<ReportDeploymentFailedInput>
> {
  return z.object({
    code: z.string(),
    message: z.string(),
  });
}

export function ReportDeploymentSucceededInputSchema(): z.ZodObject<
  Properties<ReportDeploymentSucceededInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function SetApexServiceInputSchema(): z.ZodObject<
  Properties<SetApexServiceInput>
> {
  return z.object({
    type: VetraCloudEnvironmentServiceTypeSchema.nullish(),
  });
}

export function SetAutoUpdateChannelInputSchema(): z.ZodObject<
  Properties<SetAutoUpdateChannelInput>
> {
  return z.object({
    channel: AutoUpdateChannelSchema.nullish(),
  });
}

export function SetCustomDomainInputSchema(): z.ZodObject<
  Properties<SetCustomDomainInput>
> {
  return z.object({
    domain: z.string().nullish(),
    enabled: z.boolean(),
  });
}

export function SetDefaultPackageRegistryInputSchema(): z.ZodObject<
  Properties<SetDefaultPackageRegistryInput>
> {
  return z.object({
    defaultPackageRegistry: z.url(),
  });
}

export function SetDnsRecordsInputSchema(): z.ZodObject<
  Properties<SetDnsRecordsInput>
> {
  return z.object({
    records: z.array(z.lazy(() => DnsRecordInputSchema())),
  });
}

export function SetGenericSubdomainInputSchema(): z.ZodObject<
  Properties<SetGenericSubdomainInput>
> {
  return z.object({
    genericSubdomain: z.string(),
  });
}

export function SetLabelInputSchema(): z.ZodObject<Properties<SetLabelInput>> {
  return z.object({
    label: z.string(),
  });
}

export function SetOwnerInputSchema(): z.ZodObject<Properties<SetOwnerInput>> {
  return z.object({
    address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      }),
  });
}

export function SetPackageVersionInputSchema(): z.ZodObject<
  Properties<SetPackageVersionInput>
> {
  return z.object({
    packageName: z.string(),
    version: z.string(),
  });
}

export function SetRuntimeConfigInputSchema(): z.ZodObject<
  Properties<SetRuntimeConfigInput>
> {
  return z.object({
    config: z.string().nullish(),
  });
}

export function SetServiceConfigInputSchema(): z.ZodObject<
  Properties<SetServiceConfigInput>
> {
  return z.object({
    config: z.lazy(() => VetraCloudServiceClintConfigInputSchema()),
    prefix: z.string(),
  });
}

export function SetServiceSizeInputSchema(): z.ZodObject<
  Properties<SetServiceSizeInput>
> {
  return z.object({
    prefix: z.string(),
    size: VetraCloudRessourceSizeSchema,
  });
}

export function SetServiceStatusInputSchema(): z.ZodObject<
  Properties<SetServiceStatusInput>
> {
  return z.object({
    status: ServiceStatusSchema,
    type: VetraCloudEnvironmentServiceTypeSchema,
    url: z.string().nullish(),
  });
}

export function SetServiceVersionInputSchema(): z.ZodObject<
  Properties<SetServiceVersionInput>
> {
  return z.object({
    type: VetraCloudEnvironmentServiceTypeSchema,
    version: z.string(),
  });
}

export function SleepEnvironmentInputSchema(): z.ZodObject<
  Properties<SleepEnvironmentInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function TerminateEnvironmentInputSchema(): z.ZodObject<
  Properties<TerminateEnvironmentInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function ToggleServiceInputSchema(): z.ZodObject<
  Properties<ToggleServiceInput>
> {
  return z.object({
    type: VetraCloudEnvironmentServiceTypeSchema,
  });
}

export function UnarchiveInputSchema(): z.ZodObject<
  Properties<UnarchiveInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function UpdateServicePrefixInputSchema(): z.ZodObject<
  Properties<UpdateServicePrefixInput>
> {
  return z.object({
    prefix: z.string(),
    type: VetraCloudEnvironmentServiceTypeSchema,
  });
}

export function VetraCloudEnvironmentServiceSchema(): z.ZodObject<
  Properties<VetraCloudEnvironmentService>
> {
  return z.object({
    __typename: z.literal("VetraCloudEnvironmentService").optional(),
    config: z.lazy(() => VetraCloudServiceClintSchema().nullish()),
    enabled: z.boolean(),
    prefix: z.string(),
    selectedRessource: VetraCloudRessourceSizeSchema.nullish(),
    status: ServiceStatusSchema,
    type: VetraCloudEnvironmentServiceTypeSchema,
    url: z.string().nullish(),
    version: z.string().nullish(),
  });
}

export function VetraCloudEnvironmentStateSchema(): z.ZodObject<
  Properties<VetraCloudEnvironmentState>
> {
  return z.object({
    __typename: z.literal("VetraCloudEnvironmentState").optional(),
    apexService: VetraCloudEnvironmentServiceTypeSchema.nullish(),
    autoUpdateChannel: AutoUpdateChannelSchema.nullish(),
    customDomain: z.lazy(() => VetraCustomDomainSchema().nullish()),
    defaultPackageRegistry: z.url().nullish(),
    genericBaseDomain: z.string().nullish(),
    genericSubdomain: z.string().nullish(),
    label: z.string().nullish(),
    owner: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, {
        message: "Invalid Ethereum address format",
      })
      .nullish(),
    packages: z.array(z.lazy(() => VetraCloudPackageSchema())),
    runtimeConfig: z.string().nullish(),
    services: z.array(z.lazy(() => VetraCloudEnvironmentServiceSchema())),
    status: VetraCloudEnvironmentStatusSchema,
  });
}

export function VetraCloudPackageSchema(): z.ZodObject<
  Properties<VetraCloudPackage>
> {
  return z.object({
    __typename: z.literal("VetraCloudPackage").optional(),
    name: z.string(),
    registry: z.url(),
    version: z.string().nullish(),
  });
}

export function VetraCloudPackageConfigInputSchema(): z.ZodObject<
  Properties<VetraCloudPackageConfigInput>
> {
  return z.object({
    name: z.string(),
    registry: z.url(),
    version: z.string().nullish(),
  });
}

export function VetraCloudPackageInputSchema(): z.ZodObject<
  Properties<VetraCloudPackageInput>
> {
  return z.object({
    name: z.string(),
    registry: z.url(),
    version: z.string().nullish(),
  });
}

export function VetraCloudServiceClintSchema(): z.ZodObject<
  Properties<VetraCloudServiceClint>
> {
  return z.object({
    __typename: z.literal("VetraCloudServiceClint").optional(),
    env: z.array(z.lazy(() => VetraCloudServiceEnvSchema())),
    package: z.lazy(() => VetraCloudPackageSchema()),
    selectedRessource: VetraCloudRessourceSizeSchema.nullish(),
    serviceCommand: z.string().nullish(),
  });
}

export function VetraCloudServiceClintConfigInputSchema(): z.ZodObject<
  Properties<VetraCloudServiceClintConfigInput>
> {
  return z.object({
    env: z.array(z.lazy(() => VetraCloudServiceEnvConfigInputSchema())),
    package: z.lazy(() => VetraCloudPackageConfigInputSchema()),
    selectedRessource: VetraCloudRessourceSizeSchema.nullish(),
    serviceCommand: z.string().nullish(),
  });
}

export function VetraCloudServiceClintInputSchema(): z.ZodObject<
  Properties<VetraCloudServiceClintInput>
> {
  return z.object({
    env: z.array(z.lazy(() => VetraCloudServiceEnvInputSchema())),
    package: z.lazy(() => VetraCloudPackageInputSchema()),
    selectedRessource: VetraCloudRessourceSizeSchema.nullish(),
    serviceCommand: z.string().nullish(),
  });
}

export function VetraCloudServiceEnvSchema(): z.ZodObject<
  Properties<VetraCloudServiceEnv>
> {
  return z.object({
    __typename: z.literal("VetraCloudServiceEnv").optional(),
    isSecret: z.boolean().nullish(),
    name: z.string(),
    value: z.string().nullish(),
  });
}

export function VetraCloudServiceEnvConfigInputSchema(): z.ZodObject<
  Properties<VetraCloudServiceEnvConfigInput>
> {
  return z.object({
    isSecret: z.boolean().nullish(),
    name: z.string(),
    value: z.string().nullish(),
  });
}

export function VetraCloudServiceEnvInputSchema(): z.ZodObject<
  Properties<VetraCloudServiceEnvInput>
> {
  return z.object({
    isSecret: z.boolean().nullish(),
    name: z.string(),
    value: z.string().nullish(),
  });
}

export function VetraCustomDomainSchema(): z.ZodObject<
  Properties<VetraCustomDomain>
> {
  return z.object({
    __typename: z.literal("VetraCustomDomain").optional(),
    dnsRecords: z.array(z.lazy(() => DnsRecordSchema())),
    domain: z.string().nullish(),
    enabled: z.boolean(),
  });
}

export function WakeEnvironmentInputSchema(): z.ZodObject<
  Properties<WakeEnvironmentInput>
> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}
