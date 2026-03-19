import type { DocumentDispatch } from "@powerhousedao/reactor-browser";
import {
  useDocumentById,
  useDocumentsInSelectedDrive,
  useDocumentsInSelectedFolder,
  useSelectedDocument,
} from "@powerhousedao/reactor-browser";
import type {
  VetraCloudEnvironmentAction,
  VetraCloudEnvironmentDocument,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import {
  assertIsVetraCloudEnvironmentDocument,
  isVetraCloudEnvironmentDocument,
} from "./gen/document-schema.js";

/** Hook to get a VetraCloudEnvironment document by its id */
export function useVetraCloudEnvironmentDocumentById(
  documentId: string | null | undefined,
):
  | [
      VetraCloudEnvironmentDocument,
      DocumentDispatch<VetraCloudEnvironmentAction>,
    ]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isVetraCloudEnvironmentDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected VetraCloudEnvironment document */
export function useSelectedVetraCloudEnvironmentDocument(): [
  VetraCloudEnvironmentDocument,
  DocumentDispatch<VetraCloudEnvironmentAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsVetraCloudEnvironmentDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all VetraCloudEnvironment documents in the selected drive */
export function useVetraCloudEnvironmentDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isVetraCloudEnvironmentDocument);
}

/** Hook to get all VetraCloudEnvironment documents in the selected folder */
export function useVetraCloudEnvironmentDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isVetraCloudEnvironmentDocument);
}
