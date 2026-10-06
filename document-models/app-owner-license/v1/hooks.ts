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
  AppOwnerLicenseAction,
  AppOwnerLicenseDocument,
} from "document-models/app-owner-license/v1";
import {
  assertIsAppOwnerLicenseDocument,
  isAppOwnerLicenseDocument,
} from "./gen/document-schema.js";

/** Hook to get a AppOwnerLicense document by its id */
export function useAppOwnerLicenseDocumentById(
  documentId: string | null | undefined,
):
  | [AppOwnerLicenseDocument, DocumentDispatch<AppOwnerLicenseAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isAppOwnerLicenseDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected AppOwnerLicense document */
export function useSelectedAppOwnerLicenseDocument(): [
  AppOwnerLicenseDocument,
  DocumentDispatch<AppOwnerLicenseAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsAppOwnerLicenseDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all AppOwnerLicense documents in the selected drive */
export function useAppOwnerLicenseDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isAppOwnerLicenseDocument);
}

/** Hook to get all AppOwnerLicense documents in the selected folder */
export function useAppOwnerLicenseDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isAppOwnerLicenseDocument);
}
