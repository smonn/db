import {
  acquireMigrationLock,
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  quoteIdentifier,
  readCommitted,
  trackingSchema,
  type CurrentMigration,
  type ParsedMigration,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import { applyInTransaction, loadVerifiedMigrations } from "../../runtime/migrator/index.ts";
import type { Driver, FileSystem, MigrationSource, Queryable } from "../../runtime/ports/index.ts";
import { requireSupportedServer } from "../introspect/index.ts";
import { withDevLock } from "./dev-lock.ts";

// Extensions go first: one can own a schema, which then refuses a plain drop or vanishes with it.
const EXTENSIONS = `
select extname as name from pg_extension
where extnamespace <> 'pg_catalog'::regnamespace
  or exists (
    select from pg_depend d join pg_namespace n on n.oid = d.objid
    where d.classid = 'pg_namespace'::regclass and d.refclassid = 'pg_extension'::regclass
      and d.refobjid = pg_extension.oid and d.deptype = 'e' and n.nspname !~ '^pg_'
  )`;

const NON_SYSTEM_SCHEMAS = `
select nspname as name from pg_namespace
where nspname !~ '^pg_' and nspname <> 'information_schema'`;

// public is recreated as template0 ships it, so the Dev database starts where the Shadow does.
const RECREATE_PUBLIC = `
create schema public authorization pg_database_owner;
grant usage on schema public to public;
comment on schema public is 'standard public schema';`;

/** Refuses unless the Database is marked as a Dev database or holds nothing yet (ADR-0016). */
export async function requireDevDatabase(
  driver: Driver,
  tracking: TrackingSchema,
  command: "generate" | "reset" = "generate",
): Promise<void> {
  if (await tracking.isResettable(driver)) return;
  const {
    rows: [row],
  } = await driver.query("select current_database() as name");
  throw new Error(
    `${quoteIdentifier(String(row?.["name"]))} isn't a Dev database: it has no ${tracking.currentTable} table and isn't empty, so ${command === "reset" ? "reset needs --erase to wipe it" : "generate won't reset it"}`,
  );
}

/**
 * Drops every non-system schema, then replays the Committed migrations and the Current migration,
 * all in one transaction: a SQL error rolls the wipe back and leaves the Dev database as it was.
 * Every file is transactional (ADR-0008), so one outer transaction holds them all. A failure names
 * the file that raised it.
 *
 * It holds the migrator's session lock, polled for, until its session ends, so a runtime `migrate`
 * waits instead of running on a Dev database mid-reset. A transaction-scoped lock wouldn't last:
 * reset breaks its transaction around a no-transaction file (ADR-0020).
 */
export async function resetDevDatabase(
  driver: Driver,
  committed: MigrationSource,
  tracking: TrackingSchema,
  current?: CurrentMigration,
): Promise<void> {
  // A broken chain would otherwise fail the replay after the wipe.
  const migrations = await loadVerifiedMigrations(committed);
  await driver.session(async (session) => {
    await acquireMigrationLock(session);
    await session.transaction((tx) => wipeAndReplay(tx, migrations, tracking, current));
  });
}

async function wipeAndReplay(
  tx: Queryable,
  migrations: readonly ParsedMigration[],
  tracking: TrackingSchema,
  current: CurrentMigration | undefined,
): Promise<void> {
  const { rows: extensions } = await tx.query(EXTENSIONS);
  await tx.execute(
    extensions
      .map(({ name }) => `drop extension if exists ${quoteIdentifier(String(name))} cascade;`)
      .join("\n"),
  );
  const { rows: schemas } = await tx.query(NON_SYSTEM_SCHEMAS);
  const drops = schemas.map(
    ({ name }) => `drop schema if exists ${quoteIdentifier(String(name))} cascade;`,
  );
  await tx.execute([...drops, RECREATE_PUBLIC].join("\n"));
  await tracking.createCurrentTable(tx);
  await tracking.ensureMigrationsTable(tx);
  for (const migration of migrations) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
    await replay(migration.filename, () => applyInTransaction(tx, tracking, migration));
  }
  if (current === undefined) return;
  await replay(CURRENT_FILENAME, async () => {
    await tx.execute(current.body);
    await tracking.recordCurrent(tx, current.hash);
  });
}

async function replay(filename: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(`${filename}: ${error.message}`, { cause: error });
  }
}

export type ResetOptions = {
  /** The Dev database to rebuild. */
  readonly driver: Driver;
  readonly fileSystem: FileSystem;
  /** The directory holding the Committed migrations and `current.sql`. */
  readonly migrations: string;
  /** The schema `migrate` tracks into. Defaults to `smonn_db`. */
  readonly trackingSchema?: string;
  /** Resets a Database that is neither marked as a Dev database nor empty (ADR-0016). */
  readonly erase?: boolean;
};

export type ResetResult = {
  /** How many Committed migrations it replayed. */
  readonly committed: number;
  /** Whether it also replayed `current.sql`. */
  readonly current: boolean;
};

/**
 * Rebuilds the Dev database from the files: drops every non-system schema, then replays the
 * Committed migrations and `current.sql` as written, without regenerating it. Refuses an unmarked,
 * non-empty Database unless `erase` is set.
 */
export async function reset(options: ResetOptions): Promise<ResetResult> {
  await requireSupportedServer(options.driver);
  return withDevLock(options.driver, "reset", (driver) => resetLocked({ ...options, driver }));
}

async function resetLocked(options: ResetOptions): Promise<ResetResult> {
  const { driver, fileSystem, migrations, erase = false } = options;
  const tracking = trackingSchema(options.trackingSchema ?? DEFAULT_TRACKING_SCHEMA);
  if (!erase) await requireDevDatabase(driver, tracking, "reset");
  const committed = await readCommitted(fileSystem, migrations);
  const source: MigrationSource = { list: () => Promise.resolve(committed) };
  const content = await fileSystem.readFile(`${migrations}/${CURRENT_FILENAME}`);
  let current: CurrentMigration | undefined;
  if (content !== undefined) {
    const { body } = await parseCurrent(content);
    current = { body, hash: await currentHash(body) };
  }
  await resetDevDatabase(driver, source, tracking, current);
  return { committed: committed.length, current: current !== undefined };
}
