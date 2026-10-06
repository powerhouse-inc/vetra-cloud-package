/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { DocumentDispatch } from "@powerhousedao/reactor-browser";
import {
  useDocumentById,
  useDocumentsInSelectedDrive,
  useDocumentsInSelectedFolder,
  useSelectedDocument,
} from "@powerhousedao/reactor-browser";
import type {
  AppLicenseTypeAction,
  AppLicenseTypeDocument,
} from "document-models/app-license-type/v1";
import {
  assertIsAppLicenseTypeDocument,
  isAppLicenseTypeDocument,
} from "./gen/document-schema.js";

/** Hook to get a AppLicenseType document by its id */
export function useAppLicenseTypeDocumentById(
  documentId: string | null | undefined,
):
  | [AppLicenseTypeDocument, DocumentDispatch<AppLicenseTypeAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isAppLicenseTypeDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected AppLicenseType document */
export function useSelectedAppLicenseTypeDocument(): [
  AppLicenseTypeDocument,
  DocumentDispatch<AppLicenseTypeAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsAppLicenseTypeDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all AppLicenseType documents in the selected drive */
export function useAppLicenseTypeDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isAppLicenseTypeDocument);
}

/** Hook to get all AppLicenseType documents in the selected folder */
export function useAppLicenseTypeDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isAppLicenseTypeDocument);
}
