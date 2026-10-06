/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { appOwnerLicenseDocumentType } from "./document-type.js";
import { AppOwnerLicenseStateSchema } from "./schema/zod.js";
import type {
  AppOwnerLicenseDocument,
  AppOwnerLicensePHState,
} from "./types.js";

/** Schema for validating the header object of a AppOwnerLicense document */
export const AppOwnerLicenseDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(appOwnerLicenseDocumentType),
  });

/** Schema for validating the state object of a AppOwnerLicense document */
export const AppOwnerLicensePHStateSchema = BaseDocumentStateSchema.extend({
  global: AppOwnerLicenseStateSchema(),
});

export const AppOwnerLicenseDocumentSchema = z.object({
  header: AppOwnerLicenseDocumentHeaderSchema,
  state: AppOwnerLicensePHStateSchema,
  initialState: AppOwnerLicensePHStateSchema,
});

/** Simple helper function to check if a state object is a AppOwnerLicense document state object */
export function isAppOwnerLicenseState(
  state: unknown,
): state is AppOwnerLicensePHState {
  return AppOwnerLicensePHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a AppOwnerLicense document state object */
export function assertIsAppOwnerLicenseState(
  state: unknown,
): asserts state is AppOwnerLicensePHState {
  AppOwnerLicensePHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a AppOwnerLicense document */
export function isAppOwnerLicenseDocument(
  document: unknown,
): document is AppOwnerLicenseDocument {
  return AppOwnerLicenseDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a AppOwnerLicense document */
export function assertIsAppOwnerLicenseDocument(
  document: unknown,
): asserts document is AppOwnerLicenseDocument {
  AppOwnerLicenseDocumentSchema.parse(document);
}
