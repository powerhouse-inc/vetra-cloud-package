import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { vetraCloudEnvironmentDocumentType } from "./document-type.js";
import { VetraCloudEnvironmentStateSchema } from "./schema/zod.js";
import type {
  VetraCloudEnvironmentDocument,
  VetraCloudEnvironmentPHState,
} from "./types.js";

/** Schema for validating the header object of a VetraCloudEnvironment document */
export const VetraCloudEnvironmentDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(vetraCloudEnvironmentDocumentType),
  });

/** Schema for validating the state object of a VetraCloudEnvironment document */
export const VetraCloudEnvironmentPHStateSchema =
  BaseDocumentStateSchema.extend({
    global: VetraCloudEnvironmentStateSchema(),
  });

export const VetraCloudEnvironmentDocumentSchema = z.object({
  header: VetraCloudEnvironmentDocumentHeaderSchema,
  state: VetraCloudEnvironmentPHStateSchema,
  initialState: VetraCloudEnvironmentPHStateSchema,
});

/** Simple helper function to check if a state object is a VetraCloudEnvironment document state object */
export function isVetraCloudEnvironmentState(
  state: unknown,
): state is VetraCloudEnvironmentPHState {
  return VetraCloudEnvironmentPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a VetraCloudEnvironment document state object */
export function assertIsVetraCloudEnvironmentState(
  state: unknown,
): asserts state is VetraCloudEnvironmentPHState {
  VetraCloudEnvironmentPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a VetraCloudEnvironment document */
export function isVetraCloudEnvironmentDocument(
  document: unknown,
): document is VetraCloudEnvironmentDocument {
  return VetraCloudEnvironmentDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a VetraCloudEnvironment document */
export function assertIsVetraCloudEnvironmentDocument(
  document: unknown,
): asserts document is VetraCloudEnvironmentDocument {
  VetraCloudEnvironmentDocumentSchema.parse(document);
}
