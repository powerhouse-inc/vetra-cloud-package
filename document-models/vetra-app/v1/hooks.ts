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
  VetraAppAction,
  VetraAppDocument,
} from "document-models/vetra-app/v1";
import {
  assertIsVetraAppDocument,
  isVetraAppDocument,
} from "./gen/document-schema.js";

/** Hook to get a VetraApp document by its id */
export function useVetraAppDocumentById(
  documentId: string | null | undefined,
):
  | [VetraAppDocument, DocumentDispatch<VetraAppAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isVetraAppDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected VetraApp document */
export function useSelectedVetraAppDocument(): [
  VetraAppDocument,
  DocumentDispatch<VetraAppAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsVetraAppDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all VetraApp documents in the selected drive */
export function useVetraAppDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isVetraAppDocument);
}

/** Hook to get all VetraApp documents in the selected folder */
export function useVetraAppDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isVetraAppDocument);
}
