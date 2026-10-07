/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { vetraAppDocumentType } from "./document-type.js";
import { VetraAppStateSchema } from "./schema/zod.js";
import type { VetraAppDocument, VetraAppPHState } from "./types.js";

/** Schema for validating the header object of a VetraApp document */
export const VetraAppDocumentHeaderSchema = BaseDocumentHeaderSchema.extend({
  documentType: z.literal(vetraAppDocumentType),
});

/** Schema for validating the state object of a VetraApp document */
export const VetraAppPHStateSchema = BaseDocumentStateSchema.extend({
  global: VetraAppStateSchema(),
});

export const VetraAppDocumentSchema = z.object({
  header: VetraAppDocumentHeaderSchema,
  state: VetraAppPHStateSchema,
  initialState: VetraAppPHStateSchema,
});

/** Simple helper function to check if a state object is a VetraApp document state object */
export function isVetraAppState(state: unknown): state is VetraAppPHState {
  return VetraAppPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a VetraApp document state object */
export function assertIsVetraAppState(
  state: unknown,
): asserts state is VetraAppPHState {
  VetraAppPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a VetraApp document */
export function isVetraAppDocument(
  document: unknown,
): document is VetraAppDocument {
  return VetraAppDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a VetraApp document */
export function assertIsVetraAppDocument(
  document: unknown,
): asserts document is VetraAppDocument {
  VetraAppDocumentSchema.parse(document);
}
