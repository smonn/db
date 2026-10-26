import {
  acquireMigrationLock,
  DEFAULT_TRACKING_SCHEMA,
  explainBlockerError,
  trackingSchema,
} from "../internal/index.ts";
import type { Driver, MigrationSource } from "../ports/index.ts";
import { applyInTransaction } from "./apply.ts";
import { checkRecorded, loadVerifiedMigrations } from "./verify.ts";

export type MigrateOptions = {
  readonly driver: Driver;
  readonly source: MigrationSource;
  /** Schema holding the tracking tables. Defaults to `smonn_db`. The name is always quoted, so it is case-sensitive. */
  readonly trackingSchema?: string;
};

export type MigrateResult = {
  readonly applied: readonly string[];
};

/**
 * Applies every Committed migration not yet recorded, each in its own transaction with its
 * tracking row. A session advisory lock, polled for, makes parallel runs wait, then find nothing left.
 * Before applying anything, it refuses a broken file chain, recorded rows that aren't a prefix
 * of that chain, and a last row left `started` or `failed` (ADR-0020).
 * Refuses a Dev database (ADR-0016) when migrations are pending: the tracking schema's
 * `current` table holds a row.
 */
export async function migrate({
  driver,
  source,
  trackingSchema: name = DEFAULT_TRACKING_SCHEMA,
}: MigrateOptions): Promise<MigrateResult> {
  const tracking = trackingSchema(name);
  const migrations = await loadVerifiedMigrations(source);

  return driver.session(async (session) => {
    await acquireMigrationLock(session);
    await tracking.ensureMigrationsTable(session);
    const recorded = await tracking.readRecorded(session);
    checkRecorded(migrations, recorded);
    const unfinished = await tracking.readUnfinished(session);
    if (unfinished !== undefined) {
      const table = tracking.migrationsTable;
      const where = `where sequence = ${unfinished.sequence}`;
      const stored = unfinished.error === null ? "" : `: ${unfinished.error}`;
      throw new Error(
        `${unfinished.filename} is recorded as ${unfinished.status}${stored}\n` +
          `Clean up what it left, then delete its row to retry it:\n  delete from ${table} ${where};\n` +
          `Or, when the statement did finish, mark it applied:\n  update ${table} set status = 'applied', error = null ${where};`,
      );
    }
    const pending = migrations.slice(recorded.length);
    if (pending.length > 0 && (await tracking.holdsCurrentMigration(session))) {
      throw new Error(
        `${tracking.currentTable} holds a row, so this is a Dev database; Committed migrations would run on top of an applied Current migration`,
      );
    }

    const applied: string[] = [];
    for (const migration of pending) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
        await session.transaction((tx) => applyInTransaction(tx, tracking, migration));
      } catch (error) {
        throw explainBlockerError(error, {
          source: { kind: "committed", filename: migration.filename },
        });
      }
      applied.push(migration.filename);
    }
    return { applied };
  });
}
