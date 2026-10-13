import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { DocumentPermissionService } from "@powerhousedao/reactor-api";

/**
 * reactor-api 6.2.3's real DocumentPermissionService on PGlite (tables as in
 * its migrations), every method wrapped in a spy, plus the decisions of its
 * DocumentPermissionsAuthorizationService (canRead / canMutate) for direct
 * grants (no groups, no parent inheritance), so tests can assert what an
 * external caller would be allowed to do.
 */
export async function createReactorPermissions(admins: string[] = []) {
  const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`CREATE TABLE "DocumentPermission" (
    "id" SERIAL PRIMARY KEY,
    "documentId" VARCHAR(255) NOT NULL,
    "userAddress" VARCHAR(255) NOT NULL,
    "permission" VARCHAR(20) NOT NULL CHECK ("permission" IN ('READ', 'WRITE', 'ADMIN')),
    "grantedBy" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("documentId", "userAddress"))`.execute(db);
  await sql`CREATE TABLE "OperationUserPermission" (
    "id" SERIAL PRIMARY KEY,
    "documentId" VARCHAR(255) NOT NULL,
    "operationType" VARCHAR(255) NOT NULL,
    "userAddress" VARCHAR(255) NOT NULL,
    "grantedBy" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("documentId", "operationType", "userAddress"))`.execute(db);
  await sql`CREATE TABLE "DocumentProtection" (
    "documentId" VARCHAR(255) PRIMARY KEY,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "ownerAddress" VARCHAR(255),
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  const real = new DocumentPermissionService(db as never, { defaultProtection: false });

  const perm = {
    getDocumentProtection: vi.fn((d: string) => real.getDocumentProtection(d)),
    initializeDocumentProtection: vi.fn((d: string, o: string, p?: boolean) => real.initializeDocumentProtection(d, o, p)),
    setDocumentProtection: vi.fn((d: string, p: boolean) => real.setDocumentProtection(d, p)),
    setDocumentOwner: vi.fn((d: string, o: string) => real.setDocumentOwner(d, o)),
    getDocumentPermissions: vi.fn((d: string) => real.getDocumentPermissions(d)),
    getUserPermission: vi.fn((d: string, a: string) => real.getUserPermission(d, a)),
    grantPermission: vi.fn((d: string, a: string, l: "READ" | "WRITE" | "ADMIN", by: string) =>
      real.grantPermission(d, a, l, by),
    ),
    revokePermission: vi.fn((d: string, a: string) => real.revokePermission(d, a)),
    isOperationRestricted: vi.fn((d: string, op: string) => real.isOperationRestricted(d, op)),
    grantOperationPermission: vi.fn((d: string, op: string, a: string, by: string) =>
      real.grantOperationPermission(d, op, a, by),
    ),
    getOperationUserPermissions: vi.fn((d: string, op: string) => real.getOperationUserPermissions(d, op)),
    revokeOperationPermission: vi.fn((d: string, op: string, a: string) => real.revokeOperationPermission(d, op, a)),
  };

  const isAdmin = (u?: string) => !!u && admins.includes(u.toLowerCase());
  const RANK: Record<string, number> = { READ: 1, WRITE: 2, ADMIN: 3 };
  const canAccess = async (d: string, required: "READ" | "WRITE", u?: string) => {
    if (isAdmin(u)) return true;
    if (!(await real.isDocumentProtected(d))) return true;
    if (!u) return false;
    if ((await real.getDocumentOwner(d)) === u.toLowerCase()) return true;
    const level = await real.getUserPermission(d, u);
    return level !== null && RANK[level] >= RANK[required];
  };
  const isDocumentAdmin = async (d: string, u?: string) => {
    if (isAdmin(u)) return true;
    if (!u) return false;
    if ((await real.getDocumentOwner(d)) === u.toLowerCase()) return true;
    return (await real.getUserPermission(d, u)) === "ADMIN";
  };
  const auth = {
    canRead: (d: string, u?: string) => canAccess(d, "READ", u),
    /** reactor-api's admission for one action type (execute / pushSyncEnvelopes). */
    canMutate: async (d: string, operationType: string, u?: string) => {
      if (isAdmin(u)) return true;
      if (await real.isOperationRestricted(d, operationType)) {
        if (!u) return false;
        if (await isDocumentAdmin(d, u)) return true;
        return real.hasOperationGrant(d, operationType, u);
      }
      return canAccess(d, "WRITE", u);
    },
  };
  return { db, real, perm, auth };
}
