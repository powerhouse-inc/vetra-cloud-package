/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ActivateLicenseInputSchema,
  ExpireLicenseInputSchema,
  IssueLicenseInputSchema,
  MigrateLicenseInputSchema,
  ReplaceLicenseInputSchema,
  RevokeLicenseInputSchema,
  SetStageInputSchema,
} from "../schema/zod.js";
import type {
  ActivateLicenseInput,
  ExpireLicenseInput,
  IssueLicenseInput,
  MigrateLicenseInput,
  ReplaceLicenseInput,
  RevokeLicenseInput,
  SetStageInput,
} from "../types.js";
import type {
  ActivateLicenseAction,
  ExpireLicenseAction,
  IssueLicenseAction,
  MigrateLicenseAction,
  ReplaceLicenseAction,
  RevokeLicenseAction,
  SetStageAction,
} from "./actions.js";

export const issueLicense = (input: IssueLicenseInput) =>
  createAction<IssueLicenseAction>(
    "ISSUE_LICENSE",
    { ...input },
    undefined,
    IssueLicenseInputSchema,
    "global",
  );

export const activateLicense = (input: ActivateLicenseInput) =>
  createAction<ActivateLicenseAction>(
    "ACTIVATE_LICENSE",
    { ...input },
    undefined,
    ActivateLicenseInputSchema,
    "global",
  );

export const expireLicense = (input: ExpireLicenseInput) =>
  createAction<ExpireLicenseAction>(
    "EXPIRE_LICENSE",
    { ...input },
    undefined,
    ExpireLicenseInputSchema,
    "global",
  );

export const revokeLicense = (input: RevokeLicenseInput) =>
  createAction<RevokeLicenseAction>(
    "REVOKE_LICENSE",
    { ...input },
    undefined,
    RevokeLicenseInputSchema,
    "global",
  );

export const replaceLicense = (input: ReplaceLicenseInput) =>
  createAction<ReplaceLicenseAction>(
    "REPLACE_LICENSE",
    { ...input },
    undefined,
    ReplaceLicenseInputSchema,
    "global",
  );

export const setStage = (input: SetStageInput) =>
  createAction<SetStageAction>(
    "SET_STAGE",
    { ...input },
    undefined,
    SetStageInputSchema,
    "global",
  );

export const migrateLicense = (input: MigrateLicenseInput) =>
  createAction<MigrateLicenseAction>(
    "MIGRATE_LICENSE",
    { ...input },
    undefined,
    MigrateLicenseInputSchema,
    "global",
  );
