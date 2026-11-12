import type { Kysely, Selectable } from "kysely";
import type { InstanceGateTokensTable, VetraAppsDB } from "../db/schema.js";

/**
 * Gate token rows (releases phase 3 slice 5): one per shared instance. Query
 * builder only, so table names resolve in the subgraph's namespace. Rows hold
 * the token's sha256 and its transit ciphertext, never the plaintext.
 */
export type GateTokenRow = Selectable<InstanceGateTokensTable>;

export async function getGateToken(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<GateTokenRow | null> {
  return (
    (await db
      .selectFrom("instance_gate_tokens")
      .selectAll()
      .where("instance_id", "=", instanceId)
      .executeTakeFirst()) ?? null
  );
}

/** Inserts the instance's first token; null when it already had one (a concurrent pass won). */
export async function insertGateToken(
  db: Kysely<VetraAppsDB>,
  row: GateTokenRow,
): Promise<GateTokenRow | null> {
  return (
    (await db
      .insertInto("instance_gate_tokens")
      .values(row)
      .onConflict((oc) => oc.column("instance_id").doNothing())
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/** The row, locked for the rest of the transaction (FOR UPDATE). */
export async function lockGateToken(
  trx: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<GateTokenRow | null> {
  return (
    (await trx
      .selectFrom("instance_gate_tokens")
      .selectAll()
      .where("instance_id", "=", instanceId)
      .forUpdate()
      .executeTakeFirst()) ?? null
  );
}

/**
 * Puts a new token in place (rotation). The delivered token becomes the
 * previous one, accepted until GATE_PREVIOUS_GRACE_MS after the new one is
 * delivered; an undelivered token was never in pods and is simply replaced
 * (G3). Call inside a transaction.
 */
export async function replaceGateToken(
  trx: Kysely<VetraAppsDB>,
  instanceId: string,
  next: Pick<GateTokenRow, "token_hash" | "token_ciphertext" | "token_id">,
  nowIso: string,
): Promise<GateTokenRow> {
  const cur = await lockGateToken(trx, instanceId);
  if (!cur) throw new Error(`No gate token for instance ${instanceId}`);
  const keepPrevious = cur.delivered_at === null;
  return trx
    .updateTable("instance_gate_tokens")
    .set({
      ...next,
      previous_hash: keepPrevious ? cur.previous_hash : cur.token_hash,
      previous_until: keepPrevious ? cur.previous_until : null,
      delivered_at: null,
      rotated_at: nowIso,
    })
    .where("instance_id", "=", instanceId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Records that token `tokenId` reached the tenant; the previous token's grace
 * starts now. False when that token is not the current one any more, or was
 * already marked.
 */
export async function markGateDelivered(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  tokenId: string,
  nowIso: string,
  graceMs: number,
): Promise<boolean> {
  const until = new Date(Date.parse(nowIso) + graceMs).toISOString();
  const r = await db
    .updateTable("instance_gate_tokens")
    .set((eb) => ({
      delivered_at: nowIso,
      previous_until: eb
        .case()
        .when("previous_hash", "is not", null)
        .then(until)
        .else(null)
        .end(),
    }))
    .where("instance_id", "=", instanceId)
    .where("token_id", "=", tokenId)
    .where("delivered_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export async function deleteGateToken(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("instance_gate_tokens")
    .where("instance_id", "=", instanceId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/**
 * The row a presented token's hash belongs to: its current token, or its
 * previous one while accepted (previous_until null = the new one is not
 * delivered yet, else until then).
 */
export async function findByTokenHash(
  db: Kysely<VetraAppsDB>,
  hash: string,
  nowIso: string,
): Promise<GateTokenRow | null> {
  return (
    (await db
      .selectFrom("instance_gate_tokens")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("token_hash", "=", hash),
          eb.and([
            eb("previous_hash", "=", hash),
            eb.or([
              eb("previous_until", "is", null),
              eb("previous_until", ">", nowIso),
            ]),
          ]),
        ]),
      )
      .executeTakeFirst()) ?? null
  );
}
