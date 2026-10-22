import type { Driver, MigrationSource } from "../ports/index.ts";
import { checkRecorded, loadVerifiedMigrations } from "./verify.ts";

export type MigrateOptions = {
  readonly driver: Driver;
  readonly source: MigrationSource;
};

export type MigrateResult = {
  readonly applied: readonly string[];
};

// "SMONNDBMIGRATE" on a phone keypad, per ADR-0008.
const LOCK_KEY = "76666326447283";

const TRACKING_TABLE = `
create schema if not exists smonn_db;
create table if not exists smonn_db.migrations (
  sequence integer primary key,
  filename text not null,
  hash text not null unique,
  previous_hash text references smonn_db.migrations (hash),
  applied_at timestamptz not null default now()
);`;

/**
 * Applies every Committed migration not yet recorded, each in its own transaction with its
 * tracking row. A session advisory lock makes parallel runs wait, then find nothing left.
 * Before applying anything, it refuses a broken file chain and recorded rows that aren't a prefix
 * of that chain.
 */
export async function migrate({ driver, source }: MigrateOptions): Promise<MigrateResult> {
  const migrations = await loadVerifiedMigrations(source);

  return driver.session(async (session) => {
    await session.query(`select pg_advisory_lock(${LOCK_KEY})`);
    await session.execute(TRACKING_TABLE);
    const { rows } = await session.query(
      "select filename, hash from smonn_db.migrations order by sequence",
    );
    checkRecorded(
      migrations,
      rows.map((row) => ({ filename: String(row["filename"]), hash: String(row["hash"]) })),
    );

    const applied: string[] = [];
    for (const migration of migrations.slice(rows.length)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      await session.transaction(async (tx) => {
        await tx.execute(migration.body);
        await tx.query(
          "insert into smonn_db.migrations (sequence, filename, hash, previous_hash) values ($1, $2, $3, $4)",
          [migration.sequence, migration.filename, migration.hash, migration.previous ?? null],
        );
      });
      applied.push(migration.filename);
    }
    return { applied };
  });
}
