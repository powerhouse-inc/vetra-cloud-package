import * as z from "zod";
import type {
  AddPackageInput,
  DisableServiceInput,
  EnableServiceInput,
  RemovePackageInput,
  SetEnvironmentNameInput,
  StartInput,
  StopInput,
  VetraCloudEnvironmentService,
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentStatus,
  VetraCloudPackage,
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

export const VetraCloudEnvironmentServiceSchema = z.enum([
  "CONNECT",
  "SWITCHBOARD",
]);

export const VetraCloudEnvironmentStatusSchema = z.enum(["STARTED", "STOPPED"]);

export function AddPackageInputSchema(): z.ZodObject<
  Properties<AddPackageInput>
> {
  return z.object({
    packageName: z.string(),
    version: z.string().nullish(),
  });
}

export function DisableServiceInputSchema(): z.ZodObject<
  Properties<DisableServiceInput>
> {
  return z.object({
    serviceName: VetraCloudEnvironmentServiceSchema,
  });
}

export function EnableServiceInputSchema(): z.ZodObject<
  Properties<EnableServiceInput>
> {
  return z.object({
    serviceName: VetraCloudEnvironmentServiceSchema,
  });
}

export function RemovePackageInputSchema(): z.ZodObject<
  Properties<RemovePackageInput>
> {
  return z.object({
    packageName: z.string(),
  });
}

export function SetEnvironmentNameInputSchema(): z.ZodObject<
  Properties<SetEnvironmentNameInput>
> {
  return z.object({
    name: z.string(),
  });
}

export function StartInputSchema(): z.ZodObject<Properties<StartInput>> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function StopInputSchema(): z.ZodObject<Properties<StopInput>> {
  return z.object({
    _placeholder: z.string().nullish(),
  });
}

export function VetraCloudEnvironmentStateSchema(): z.ZodObject<
  Properties<VetraCloudEnvironmentState>
> {
  return z.object({
    __typename: z.literal("VetraCloudEnvironmentState").optional(),
    name: z.string().nullish(),
    packages: z.array(z.lazy(() => VetraCloudPackageSchema())).nullish(),
    services: z.array(VetraCloudEnvironmentServiceSchema),
    status: VetraCloudEnvironmentStatusSchema,
  });
}

export function VetraCloudPackageSchema(): z.ZodObject<
  Properties<VetraCloudPackage>
> {
  return z.object({
    __typename: z.literal("VetraCloudPackage").optional(),
    name: z.string(),
    version: z.string().nullish(),
  });
}
