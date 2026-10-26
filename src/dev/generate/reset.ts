import {
  acquireMigrationLock,
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  quoteIdentifier,
  readCommitted,
  splitCurrentHeader,
  trackingSchema,
  type CurrentMigration,
  type ParsedMigration,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import { applyMigration, loadVerifiedMigrations } from "../../runtime/migrator/index.ts";
import type {
  Driver,
  FileSystem,
  MigrationSource,
  Queryable,
  Session,
} from "../../runtime/ports/index.ts";
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
  driver: Queryable,
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

type ResetSteps = {
  /** The Current migration to replay after the Committed ones. */
  readonly current?: CurrentMigration;
  readonly afterLock?: (session: Queryable) => Promise<void>;
};

/**
 * Drops every non-system schema, then replays the Committed migrations and the Current migration.
 * The wipe and the transactional files up to the first no-transaction file (ADR-0020) share one
 * transaction: a SQL error in them rolls the wipe back and leaves the Dev database as it was. A
 * no-transaction file breaks that transaction: what ran before it is committed, the file runs in
 * autocommit, and the files after it share the next transaction. A failure after such a file
 * leaves the Dev database wiped and partly replayed. A failure names the file that raised it.
 *
 * It holds the migrator's session lock, polled for, until its session ends, so a runtime `migrate`
 * waits instead of running on a Dev database mid-reset. A transaction-scoped lock wouldn't last
 * across the break.
 *
 * `afterLock` runs on the locked session before the wipe, so a check there sees the Database as a
 * runtime `migrate` left it.
 */
export async function resetDevDatabase(
  driver: Driver,
  committed: MigrationSource,
  tracking: TrackingSchema,
  { current, afterLock }: ResetSteps = {},
): Promise<void> {
  // A broken chain would otherwise fail the replay after the wipe.
  const migrations = await loadVerifiedMigrations(committed);
  await driver.session(async (session) => {
    await acquireMigrationLock(session);
    await afterLock?.(session);
    let rest = await session.transaction(async (tx) => {
      await wipe(tx, tracking);
      return replayInTransaction(session, tx, replaySteps(migrations, tracking, current));
    });
    while (rest.length > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
      rest = await replayNext(session, rest);
    }
  });
}

async function replayNext(
  session: Session,
  steps: readonly ReplayStep[],
): Promise<readonly ReplayStep[]> {
  const [first] = steps;
  if (first?.noTransaction === true) {
    await replay(first.name, () => first.run(session, session));
    return steps.slice(1);
  }
  return session.transaction((tx) => replayInTransaction(session, tx, steps));
}

type ReplayStep = {
  readonly name: string;
  readonly noTransaction: boolean;
  /** `tx` is the open transaction, or the session itself for a no-transaction step. */
  run(session: Queryable, tx: Queryable): Promise<void>;
};

function replaySteps(
  migrations: readonly ParsedMigration[],
  tracking: TrackingSchema,
  current: CurrentMigration | undefined,
): ReplayStep[] {
  const steps = migrations.map((migration): ReplayStep => ({
    name: migration.filename,
    noTransaction: migration.noTransaction,
    run: (session, tx) => applyMigration(session, tracking, migration, (fn) => fn(tx)),
  }));
  if (current !== undefined) {
    steps.push({
      name: CURRENT_FILENAME,
      noTransaction: splitCurrentHeader(current.body).noTransaction,
      run: async (_session, tx) => {
        await tx.execute(current.body);
        await tracking.recordCurrent(tx, current.hash);
      },
    });
  }
  return steps;
}

/** Replays the steps up to the first no-transaction one on `tx`, and returns the steps left. */
async function replayInTransaction(
  session: Queryable,
  tx: Queryable,
  steps: readonly ReplayStep[],
): Promise<readonly ReplayStep[]> {
  const stop = steps.findIndex((step) => step.noTransaction);
  const count = stop === -1 ? steps.length : stop;
  for (const step of steps.slice(0, count)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each file builds on the one before it.
    await replay(step.name, () => step.run(session, tx));
  }
  return steps.slice(count);
}

async function wipe(tx: Queryable, tracking: TrackingSchema): Promise<void> {
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
  const committed = await readCommitted(fileSystem, migrations);
  const source: MigrationSource = { list: () => Promise.resolve(committed) };
  const content = await fileSystem.readFile(`${migrations}/${CURRENT_FILENAME}`);
  let current: CurrentMigration | undefined;
  if (content !== undefined) {
    const { body } = await parseCurrent(content);
    current = { body, hash: await currentHash(body) };
  }
  await resetDevDatabase(driver, source, tracking, {
    ...(current === undefined ? {} : { current }),
    ...(erase ? {} : { afterLock: (session) => requireDevDatabase(session, tracking, "reset") }),
  });
  return { committed: committed.length, current: current !== undefined };
}
