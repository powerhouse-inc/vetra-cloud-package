/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { appLicenseTypeDocumentType } from "./document-type.js";
import { AppLicenseTypeStateSchema } from "./schema/zod.js";
import type { AppLicenseTypeDocument, AppLicenseTypePHState } from "./types.js";

/** Schema for validating the header object of a AppLicenseType document */
export const AppLicenseTypeDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(appLicenseTypeDocumentType),
  });

/** Schema for validating the state object of a AppLicenseType document */
export const AppLicenseTypePHStateSchema = BaseDocumentStateSchema.extend({
  global: AppLicenseTypeStateSchema(),
});

export const AppLicenseTypeDocumentSchema = z.object({
  header: AppLicenseTypeDocumentHeaderSchema,
  state: AppLicenseTypePHStateSchema,
  initialState: AppLicenseTypePHStateSchema,
});

/** Simple helper function to check if a state object is a AppLicenseType document state object */
export function isAppLicenseTypeState(
  state: unknown,
): state is AppLicenseTypePHState {
  return AppLicenseTypePHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a AppLicenseType document state object */
export function assertIsAppLicenseTypeState(
  state: unknown,
): asserts state is AppLicenseTypePHState {
  AppLicenseTypePHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a AppLicenseType document */
export function isAppLicenseTypeDocument(
  document: unknown,
): document is AppLicenseTypeDocument {
  return AppLicenseTypeDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a AppLicenseType document */
export function assertIsAppLicenseTypeDocument(
  document: unknown,
): asserts document is AppLicenseTypeDocument {
  AppLicenseTypeDocumentSchema.parse(document);
}
