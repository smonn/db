import type { ParsedMigration, TrackingSchema } from "../internal/index.ts";
import type { Queryable } from "../ports/index.ts";

/**
 * Runs a transactional Committed migration's body and records it, on a transaction the caller
 * opened and owns: `migrate` opens one per file, `reset` replays every file in one. A
 * no-transaction file (ADR-0020) takes a sibling step that runs on a session instead.
 */
export async function applyInTransaction(
  tx: Queryable,
  tracking: TrackingSchema,
  migration: ParsedMigration,
): Promise<void> {
  await tx.execute(migration.body);
  await tracking.recordMigration(tx, migration);
}
