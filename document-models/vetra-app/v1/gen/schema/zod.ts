/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AutoUpdateChannel,
  ConnectRepositoryInput,
  SetAppDetailsInput,
  SetIdentityInput,
  SetPreviewsInput,
  SetProductionEnvironmentInput,
  SetStatusInput,
  VetraAppArtifact,
  VetraAppArtifactChannel,
  VetraAppArtifactKind,
  VetraAppArtifactVersion,
  VetraAppIdentity,
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

export const VetraAppArtifactKindSchema = z.enum(["FUSION_IMAGE", "PACKAGE"]);

export const VetraAppStatusSchema = z.enum([
  "ACTIVE",
  "DELETED",
  "DISCONNECTED",
  "PENDING_IDENTITY",
]);

export function ConnectRepositoryInputSchema(): z.ZodObject<
  Properties<ConnectRepositoryInput>
> {
  return z.object({
    fullName: z.string().nullish(),
    productionBranch: z.string().nullish(),
    repositoryId: z.string().nullish(),
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

export function VetraAppIdentitySchema(): z.ZodObject<
  Properties<VetraAppIdentity>
> {
  return z.object({
    __typename: z.literal("VetraAppIdentity").optional(),
    did: z.string().nullish(),
    expiresAt: z.iso.datetime().nullish(),
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
  });
}
