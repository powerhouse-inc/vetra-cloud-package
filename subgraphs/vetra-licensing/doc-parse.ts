/** Defensive readers for reactor documents, shared by every licensing read. */

type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null;
export const str = (v: unknown): string | null =>
  typeof v === "string" ? v : null;

export function docId(doc: unknown): string | null {
  if (!isRec(doc) || !isRec(doc.header)) return null;
  return str(doc.header.id);
}

/** True when the document's own type is the expected one. */
export function isDocType(doc: unknown, type: string): boolean {
  return isRec(doc) && isRec(doc.header) && doc.header.documentType === type;
}

export function globalState(doc: unknown): Rec | null {
  if (!isRec(doc) || !isRec(doc.state) || !isRec(doc.state.global)) return null;
  return doc.state.global;
}
