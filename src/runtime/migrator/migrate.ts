import { DEFAULT_TRACKING_SCHEMA, quoteTrackingSchema } from "../internal/index.ts";
import type { Driver, MigrationSource, Queryable } from "../ports/index.ts";
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

const trackingTable = (schema: string): string => `
create schema if not exists ${schema};
create table if not exists ${schema}.migrations (
  sequence integer primary key,
  filename text not null,
  hash text not null unique,
  previous_hash text references ${schema}.migrations (hash),
  applied_at timestamptz not null default now()
);`;

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
  trackingSchema = DEFAULT_TRACKING_SCHEMA,
}: MigrateOptions): Promise<MigrateResult> {
  const schema = quoteTrackingSchema(trackingSchema);
  const migrations = await loadVerifiedMigrations(source);

  return driver.session(async (session) => {
    await session.query(`select pg_advisory_lock(${LOCK_KEY})`);
    await session.execute(trackingTable(schema));
    const { rows } = await session.query(
      `select filename, hash from ${schema}.migrations order by sequence`,
    );
    checkRecorded(
      migrations,
      rows.map((row) => ({ filename: String(row["filename"]), hash: String(row["hash"]) })),
    );
    const pending = migrations.slice(rows.length);
    if (pending.length > 0) {
      await refuseDevDatabase(session, schema, trackingSchema);
    }

    const applied: string[] = [];
    for (const migration of pending) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      await session.transaction(async (tx) => {
        await tx.execute(migration.body);
        await tx.query(
          `insert into ${schema}.migrations (sequence, filename, hash, previous_hash) values ($1, $2, $3, $4)`,
          [migration.sequence, migration.filename, migration.hash, migration.previous ?? null],
        );
      });
      applied.push(migration.filename);
    }
    return { applied };
  });
}

async function refuseDevDatabase(session: Queryable, schema: string, name: string): Promise<void> {
  const {
    rows: [table],
  } = await session.query("select to_regclass($1) is not null as present", [`${schema}.current`]);
  if (table?.["present"] !== true) {
    return;
  }
  const {
    rows: [marker],
  } = await session.query(`select exists (select 1 from ${schema}.current) as marked`);
  if (marker?.["marked"] === true) {
    throw new Error(
      `${name}.current holds a row, so this is a Dev database; Committed migrations would run on top of an applied Current migration`,
    );
  }
}
