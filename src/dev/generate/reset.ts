import {
  CURRENT_FILENAME,
  currentHash,
  DEFAULT_TRACKING_SCHEMA,
  parseCurrent,
  quoteIdentifier,
  readCommitted,
  trackingSchema,
  type CurrentMigration,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Driver, FileSystem, MigrationSource } from "../../runtime/ports/index.ts";
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

/** Drops every non-system schema, then replays the Committed migrations and the Current migration. */
export async function resetDevDatabase(
  driver: Driver,
  committed: MigrationSource,
  tracking: TrackingSchema,
  current?: CurrentMigration,
): Promise<void> {
  await driver.transaction(async (tx) => {
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
  });
  await migrate({ driver, source: committed, trackingSchema: tracking.name });
  if (current === undefined) return;
  await driver.transaction(async (tx) => {
    await tx.execute(current.body);
    await tracking.recordCurrent(tx, current.hash);
  });
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
export function reset(options: ResetOptions): Promise<ResetResult> {
  return withDevLock(options.driver, "reset", (driver) => resetLocked({ ...options, driver }));
}

async function resetLocked(options: ResetOptions): Promise<ResetResult> {
  const { driver, fileSystem, migrations, erase = false } = options;
  const tracking = trackingSchema(options.trackingSchema ?? DEFAULT_TRACKING_SCHEMA);
  if (!erase) await requireDevDatabase(driver, tracking, "reset");
  const committed = await readCommitted(fileSystem, migrations);
  const content = await fileSystem.readFile(`${migrations}/${CURRENT_FILENAME}`);
  let current: CurrentMigration | undefined;
  if (content !== undefined) {
    const { body } = await parseCurrent(content);
    current = { body, hash: await currentHash(body) };
  }
  await resetDevDatabase(driver, { list: () => Promise.resolve(committed) }, tracking, current);
  return { committed: committed.length, current: current !== undefined };
}
