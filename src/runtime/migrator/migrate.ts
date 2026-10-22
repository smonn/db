import { DEFAULT_TRACKING_SCHEMA, trackingSchema } from "../internal/index.ts";
import type { Driver, MigrationSource } from "../ports/index.ts";
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

// "SMONNDBMIGRATE" on a phone keypad, per ADR-0008.
const LOCK_KEY = "76666326447283";

/**
 * Applies every Committed migration not yet recorded, each in its own transaction with its
 * tracking row. A session advisory lock makes parallel runs wait, then find nothing left.
 * Before applying anything, it refuses a broken file chain and recorded rows that aren't a prefix
 * of that chain.
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
    await session.query(`select pg_advisory_lock(${LOCK_KEY})`);
    await tracking.ensureMigrationsTable(session);
    const recorded = await tracking.readRecorded(session);
    checkRecorded(migrations, recorded);
    const pending = migrations.slice(recorded.length);
    if (pending.length > 0 && (await tracking.holdsCurrentMigration(session))) {
      throw new Error(
        `${tracking.name}.current holds a row, so this is a Dev database; Committed migrations would run on top of an applied Current migration`,
      );
    }

    const applied: string[] = [];
    for (const migration of pending) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      await session.transaction(async (tx) => {
        await tx.execute(migration.body);
        await tracking.recordMigration(tx, migration);
      });
      applied.push(migration.filename);
    }
    return { applied };
  });
}
