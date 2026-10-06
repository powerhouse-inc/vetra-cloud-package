/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AddTemplatePackageInputSchema,
  AddTemplateServiceInputSchema,
  PublishLicenseTypeInputSchema,
  RetireLicenseTypeInputSchema,
  SetLicenseTypeDetailsInputSchema,
  SetTemplateInputSchema,
} from "../schema/zod.js";
import type {
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  PublishLicenseTypeInput,
  RetireLicenseTypeInput,
  SetLicenseTypeDetailsInput,
  SetTemplateInput,
} from "../types.js";
import type {
  AddTemplatePackageAction,
  AddTemplateServiceAction,
  PublishLicenseTypeAction,
  RetireLicenseTypeAction,
  SetLicenseTypeDetailsAction,
  SetTemplateAction,
} from "./actions.js";

export const setLicenseTypeDetails = (input: SetLicenseTypeDetailsInput) =>
  createAction<SetLicenseTypeDetailsAction>(
    "SET_LICENSE_TYPE_DETAILS",
    { ...input },
    undefined,
    SetLicenseTypeDetailsInputSchema,
    "global",
  );

export const setTemplate = (input: SetTemplateInput) =>
  createAction<SetTemplateAction>(
    "SET_TEMPLATE",
    { ...input },
    undefined,
    SetTemplateInputSchema,
    "global",
  );

export const addTemplateService = (input: AddTemplateServiceInput) =>
  createAction<AddTemplateServiceAction>(
    "ADD_TEMPLATE_SERVICE",
    { ...input },
    undefined,
    AddTemplateServiceInputSchema,
    "global",
  );

export const addTemplatePackage = (input: AddTemplatePackageInput) =>
  createAction<AddTemplatePackageAction>(
    "ADD_TEMPLATE_PACKAGE",
    { ...input },
    undefined,
    AddTemplatePackageInputSchema,
    "global",
  );

export const publishLicenseType = (input: PublishLicenseTypeInput) =>
  createAction<PublishLicenseTypeAction>(
    "PUBLISH_LICENSE_TYPE",
    { ...input },
    undefined,
    PublishLicenseTypeInputSchema,
    "global",
  );

export const retireLicenseType = (input: RetireLicenseTypeInput) =>
  createAction<RetireLicenseTypeAction>(
    "RETIRE_LICENSE_TYPE",
    { ...input },
    undefined,
    RetireLicenseTypeInputSchema,
    "global",
  );
