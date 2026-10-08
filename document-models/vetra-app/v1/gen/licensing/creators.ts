/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AddTemplateInputSchema,
  AddTemplatePackageInputSchema,
  AddTemplateServiceInputSchema,
  AddTermInputSchema,
  DeleteTemplateInputSchema,
  PublishTermInputSchema,
  RemoveTemplatePackageInputSchema,
  RemoveTemplateServiceInputSchema,
  RetireTermInputSchema,
  SetTemplateDetailsInputSchema,
  SetTermDetailsInputSchema,
} from "../schema/zod.js";
import type {
  AddTemplateInput,
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AddTermInput,
  DeleteTemplateInput,
  PublishTermInput,
  RemoveTemplatePackageInput,
  RemoveTemplateServiceInput,
  RetireTermInput,
  SetTemplateDetailsInput,
  SetTermDetailsInput,
} from "../types.js";
import type {
  AddTemplateAction,
  AddTemplatePackageAction,
  AddTemplateServiceAction,
  AddTermAction,
  DeleteTemplateAction,
  PublishTermAction,
  RemoveTemplatePackageAction,
  RemoveTemplateServiceAction,
  RetireTermAction,
  SetTemplateDetailsAction,
  SetTermDetailsAction,
} from "./actions.js";

export const addTemplate = (input: AddTemplateInput) =>
  createAction<AddTemplateAction>(
    "ADD_TEMPLATE",
    { ...input },
    undefined,
    AddTemplateInputSchema,
    "global",
  );

export const setTemplateDetails = (input: SetTemplateDetailsInput) =>
  createAction<SetTemplateDetailsAction>(
    "SET_TEMPLATE_DETAILS",
    { ...input },
    undefined,
    SetTemplateDetailsInputSchema,
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

export const removeTemplateService = (input: RemoveTemplateServiceInput) =>
  createAction<RemoveTemplateServiceAction>(
    "REMOVE_TEMPLATE_SERVICE",
    { ...input },
    undefined,
    RemoveTemplateServiceInputSchema,
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

export const removeTemplatePackage = (input: RemoveTemplatePackageInput) =>
  createAction<RemoveTemplatePackageAction>(
    "REMOVE_TEMPLATE_PACKAGE",
    { ...input },
    undefined,
    RemoveTemplatePackageInputSchema,
    "global",
  );

export const deleteTemplate = (input: DeleteTemplateInput) =>
  createAction<DeleteTemplateAction>(
    "DELETE_TEMPLATE",
    { ...input },
    undefined,
    DeleteTemplateInputSchema,
    "global",
  );

export const addTerm = (input: AddTermInput) =>
  createAction<AddTermAction>(
    "ADD_TERM",
    { ...input },
    undefined,
    AddTermInputSchema,
    "global",
  );

export const setTermDetails = (input: SetTermDetailsInput) =>
  createAction<SetTermDetailsAction>(
    "SET_TERM_DETAILS",
    { ...input },
    undefined,
    SetTermDetailsInputSchema,
    "global",
  );

export const publishTerm = (input: PublishTermInput) =>
  createAction<PublishTermAction>(
    "PUBLISH_TERM",
    { ...input },
    undefined,
    PublishTermInputSchema,
    "global",
  );

export const retireTerm = (input: RetireTermInput) =>
  createAction<RetireTermAction>(
    "RETIRE_TERM",
    { ...input },
    undefined,
    RetireTermInputSchema,
    "global",
  );
