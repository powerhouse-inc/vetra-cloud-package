/* eslint-disable @typescript-eslint/no-empty-object-type */
import * as z from "zod";
import type {
  AddPackageInput,
  ApproveChangesInput,
  ArchiveInput,
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
  SetCustomDomainInput,
  SetDnsRecordsInput,
  SetGenericSubdomainInput,
  SetLabelInput,
  SetServiceStatusInput,
  TerminateEnvironmentInput,
  ToggleServiceInput,
  UnarchiveInput,
  UpdateServicePrefixInput,
  VetraCloudEnvironmentService,
  VetraCloudEnvironmentServiceType,
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentStatus,
  VetraCloudPackage,
  VetraCustomDomain,
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

export const ServiceStatusSchema = z.enum([
  "ACTIVE",
  "BILLING_ISSUE",
  "PROVISIONING",
  "SUSPENDED",
]);

export const VetraCloudEnvironmentServiceTypeSchema = z.enum([
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
    prefix: z.string(),
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

export function SetCustomDomainInputSchema(): z.ZodObject<
  Properties<SetCustomDomainInput>
> {
  return z.object({
    domain: z.string().nullish(),
    enabled: z.boolean(),
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

export function SetServiceStatusInputSchema(): z.ZodObject<
  Properties<SetServiceStatusInput>
> {
  return z.object({
    status: ServiceStatusSchema,
    type: VetraCloudEnvironmentServiceTypeSchema,
    url: z.string().nullish(),
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
    enabled: z.boolean(),
    prefix: z.string(),
    status: ServiceStatusSchema,
    type: VetraCloudEnvironmentServiceTypeSchema,
    url: z.string().nullish(),
  });
}

export function VetraCloudEnvironmentStateSchema(): z.ZodObject<
  Properties<VetraCloudEnvironmentState>
> {
  return z.object({
    __typename: z.literal("VetraCloudEnvironmentState").optional(),
    customDomain: z.lazy(() => VetraCustomDomainSchema().nullish()),
    defaultPackageRegistry: z.url().nullish(),
    genericBaseDomain: z.string().nullish(),
    genericSubdomain: z.string().nullish(),
    label: z.string().nullish(),
    packages: z.array(z.lazy(() => VetraCloudPackageSchema())),
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
