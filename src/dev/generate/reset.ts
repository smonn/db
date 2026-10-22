import {
  quoteIdentifier,
  quoteTrackingSchema,
  type CurrentMigration,
} from "../../runtime/internal/index.ts";
import { migrate } from "../../runtime/migrator/index.ts";
import type { Driver, MigrationSource } from "../../runtime/ports/index.ts";

// A Dev database holds the tracking schema's current table, or nothing outside an empty public.
const DEV_DATABASE = `
select current_database() as name,
  to_regclass($1) is not null
  or (
    not exists (
      select from pg_namespace
      where nspname !~ '^pg_' and nspname not in ('information_schema', 'public')
    )
    -- Every object created in a schema, of any kind, records a dependency on it.
    and not exists (
      select from pg_depend
      where refclassid = 'pg_namespace'::regclass and refobjid = to_regnamespace('public')
    )
  ) as resettable`;

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
const RECREATE = (schema: string): string => `
create schema public authorization pg_database_owner;
grant usage on schema public to public;
comment on schema public is 'standard public schema';
create schema ${schema};
create table ${schema}.current (hash text not null, applied_at timestamptz not null default now());`;

/** Refuses unless the Database is marked as a Dev database or holds nothing yet (ADR-0016). */
export async function requireDevDatabase(driver: Driver, trackingSchema: string): Promise<void> {
  const {
    rows: [row],
  } = await driver.query(DEV_DATABASE, [`${quoteTrackingSchema(trackingSchema)}.current`]);
  if (row?.["resettable"] !== true) {
    throw new Error(
      `${String(row?.["name"])} isn't a Dev database: it has no ${trackingSchema}.current table and isn't empty, so generate won't reset it`,
    );
  }
}

/** Drops every non-system schema, then replays the Committed migrations and the Current migration. */
export async function resetDevDatabase(
  driver: Driver,
  committed: MigrationSource,
  trackingSchema: string,
  current?: CurrentMigration,
): Promise<void> {
  const schema = quoteTrackingSchema(trackingSchema);
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
    await tx.execute([...drops, RECREATE(schema)].join("\n"));
  });
  await migrate({ driver, source: committed, trackingSchema });
  if (current === undefined) return;
  await driver.transaction(async (tx) => {
    await tx.execute(current.body);
    await tx.query(`insert into ${schema}.current (hash) values ($1)`, [current.hash]);
  });
}
