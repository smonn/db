import type { ParsedMigration } from "./migration-file.ts";
import type { Queryable } from "../ports/index.ts";
import { quoteIdentifier } from "./quote-identifier.ts";

export const DEFAULT_TRACKING_SCHEMA = "smonn_db";

const MAX_IDENTIFIER_BYTES = 63;

export type RecordedMigration = {
  readonly filename: string;
  readonly hash: string;
};

/** The tracking schema's `migrations` and `current` tables (ADR-0008, ADR-0016). */
export type TrackingSchema = {
  /** The name as configured, unquoted, for messages and catalog lookups. */
  readonly name: string;
  ensureMigrationsTable(session: Queryable): Promise<void>;
  /** The recorded rows, in sequence order. */
  readRecorded(session: Queryable): Promise<RecordedMigration[]>;
  /** Records an applied migration. Run it in the transaction that applied the body. */
  recordMigration(tx: Queryable, migration: ParsedMigration): Promise<void>;
  /** Whether `current` holds a row, which marks a Dev database with an applied Current migration. */
  holdsCurrentMigration(session: Queryable): Promise<boolean>;
  /** Whether reset may drop everything: `current` exists, or nothing outside an empty public does. */
  isResettable(session: Queryable): Promise<boolean>;
  /** Creates the schema and its `current` table. Only Dev code calls it (ADR-0016). */
  createCurrentTable(tx: Queryable): Promise<void>;
  recordCurrent(tx: Queryable, hash: string): Promise<void>;
  /** The hash `current` holds, or `undefined` when the table is missing or empty. */
  readCurrent(session: Queryable): Promise<string | undefined>;
  clearCurrent(tx: Queryable): Promise<void>;
};

// A Dev database holds the tracking schema's current table, or nothing outside an empty public.
const RESETTABLE = `
select to_regclass($1) is not null
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

// Each builder takes the quoted schema name.
const MIGRATIONS_TABLE = (schema: string): string => `
create schema if not exists ${schema};
create table if not exists ${schema}.migrations (
  sequence integer primary key,
  filename text not null,
  hash text not null unique,
  previous_hash text references ${schema}.migrations (hash),
  applied_at timestamptz not null default now()
);`;

const CURRENT_TABLE = (schema: string): string => `
create schema ${schema};
create table ${schema}.current (hash text not null, applied_at timestamptz not null default now());`;

/** Validates a tracking schema name and holds its quoted form for the tracking tables' SQL. */
export function trackingSchema(name: string): TrackingSchema {
  const schema = quoteTrackingSchema(name);
  const current = `${schema}.current`;

  async function readCurrent(session: Queryable): Promise<string | undefined> {
    const { rows } = (await tableExists(session, current))
      ? await session.query(`select hash from ${schema}.current`)
      : { rows: [] };
    const hash: unknown = rows[0]?.["hash"];
    return typeof hash === "string" ? hash : undefined;
  }

  return {
    name,

    async ensureMigrationsTable(session) {
      await session.execute(MIGRATIONS_TABLE(schema));
    },

    async readRecorded(session) {
      const { rows } = await session.query(
        `select filename, hash from ${schema}.migrations order by sequence`,
      );
      return rows.map((row) => ({ filename: String(row["filename"]), hash: String(row["hash"]) }));
    },

    async recordMigration(tx, migration) {
      await tx.query(
        `insert into ${schema}.migrations (sequence, filename, hash, previous_hash) values ($1, $2, $3, $4)`,
        [migration.sequence, migration.filename, migration.hash, migration.previous ?? null],
      );
    },

    holdsCurrentMigration: async (session) => (await readCurrent(session)) !== undefined,

    isResettable: (session) => isResettable(session, current),

    async createCurrentTable(tx) {
      await tx.execute(CURRENT_TABLE(schema));
    },

    async recordCurrent(tx, hash) {
      await tx.query(`insert into ${schema}.current (hash) values ($1)`, [hash]);
    },

    readCurrent,

    clearCurrent: (tx) => tx.execute(`delete from ${schema}.current`),
  };
}

/** `table` is a quoted, qualified table name, bound as a value. */
async function tableExists(session: Queryable, table: string): Promise<boolean> {
  const {
    rows: [row],
  } = await session.query("select to_regclass($1) is not null as present", [table]);
  return row?.["present"] === true;
}

/** `current` is the quoted, qualified name of the `current` table, bound as a value. */
async function isResettable(session: Queryable, current: string): Promise<boolean> {
  const {
    rows: [row],
  } = await session.query(RESETTABLE, [current]);
  return row?.["resettable"] === true;
}

function quoteTrackingSchema(name: string): string {
  if (name === "") {
    throw new Error("trackingSchema must not be empty");
  }
  if (name.includes("\0")) {
    throw new Error("trackingSchema must not contain a NUL byte");
  }
  if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`trackingSchema must be at most ${MAX_IDENTIFIER_BYTES} bytes in UTF-8`);
  }
  if (name.startsWith("pg_")) {
    throw new Error('trackingSchema must not start with "pg_", which Postgres reserves');
  }
  return quoteIdentifier(name);
}
