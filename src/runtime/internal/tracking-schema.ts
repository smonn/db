import type { ParsedMigration } from "./migration-file.ts";
import type { Queryable } from "../ports/index.ts";
import { quoteIdentifier } from "./quote-identifier.ts";

export const DEFAULT_TRACKING_SCHEMA = "smonn_db";

const MAX_IDENTIFIER_BYTES = 63;

export type RecordedMigration = {
  readonly filename: string;
  readonly hash: string;
};

/** The last recorded row, when it never reached `applied` (ADR-0020). */
type UnfinishedMigration = {
  readonly sequence: number;
  readonly filename: string;
  readonly status: string;
  readonly error: string | null;
};

/** The tracking schema's `migrations` and `current` tables (ADR-0008, ADR-0016). */
export type TrackingSchema = {
  /** The name as configured, unquoted, for catalog lookups. */
  readonly name: string;
  /** The `current` table's quoted, qualified name, for messages. */
  readonly currentTable: string;
  ensureMigrationsTable(session: Queryable): Promise<void>;
  /** The `migrations` table's quoted, qualified name, for messages. */
  readonly migrationsTable: string;
  /** The last recorded row when its status is `started` or `failed`, else `undefined`. */
  readUnfinished(session: Queryable): Promise<UnfinishedMigration | undefined>;
  /** The recorded rows, in sequence order. */
  readRecorded(session: Queryable): Promise<RecordedMigration[]>;
  /** Records an applied migration. Run it in the transaction that applied the body. */
  recordMigration(tx: Queryable, migration: ParsedMigration): Promise<void>;
  /**
   * Records a no-transaction migration as `started`, before its statement runs. Run it in
   * autocommit, so the row survives a failure of the statement (ADR-0020).
   */
  recordStarted(session: Queryable, migration: ParsedMigration): Promise<void>;
  markApplied(session: Queryable, migration: ParsedMigration): Promise<void>;
  markFailed(session: Queryable, migration: ParsedMigration, error: string): Promise<void>;
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
  /** Whether the `current` table exists, which marks a Dev database even when it holds no row. */
  hasCurrentTable(session: Queryable): Promise<boolean>;
  /** The hash of the last recorded migration, or `undefined` when none is recorded or the table is missing. */
  readTip(session: Queryable): Promise<string | undefined>;
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
  applied_at timestamptz not null default now(),
  status text not null default 'applied',
  error text
);
alter table ${schema}.migrations add column if not exists status text not null default 'applied';
alter table ${schema}.migrations add column if not exists error text;`;

const READ_LAST = (schema: string): string =>
  `select sequence, filename, status, error from ${schema}.migrations order by sequence desc limit 1`;

const CURRENT_TABLE = (schema: string): string => `
create schema ${schema};
create table ${schema}.current (hash text not null, applied_at timestamptz not null default now());`;

/** Validates a tracking schema name and holds its quoted form for the tracking tables' SQL. */
export function trackingSchema(name: string): TrackingSchema {
  const schema = quoteTrackingSchema(name);
  const current = `${schema}.${quoteIdentifier("current")}`;

  const readCurrent = (session: Queryable): Promise<string | undefined> =>
    readHash(session, current, `select hash from ${schema}.current`);

  return {
    name,
    currentTable: current,
    migrationsTable: `${schema}.${quoteIdentifier("migrations")}`,

    readUnfinished: (session) => readUnfinished(session, schema),

    ensureMigrationsTable: (session) => session.execute(MIGRATIONS_TABLE(schema)),

    async readRecorded(session) {
      const { rows } = await session.query(
        `select filename, hash from ${schema}.migrations order by sequence`,
      );
      return rows.map((row) => ({ filename: String(row["filename"]), hash: String(row["hash"]) }));
    },

    ...migrationRows(schema),

    holdsCurrentMigration: async (session) => (await readCurrent(session)) !== undefined,
    isResettable: (session) => isResettable(session, current),
    createCurrentTable: (tx) => tx.execute(CURRENT_TABLE(schema)),

    async recordCurrent(tx, hash) {
      await tx.query(`insert into ${schema}.current (hash) values ($1)`, [hash]);
    },

    readCurrent,
    clearCurrent: (tx) => tx.execute(`delete from ${schema}.current`),
    hasCurrentTable: (session) => tableExists(session, current),

    readTip: (session) =>
      readHash(
        session,
        `${schema}.${quoteIdentifier("migrations")}`,
        `select hash from ${schema}.migrations order by sequence desc limit 1`,
      ),
  };
}

const INSERT_MIGRATION = (schema: string, status: "applied" | "started"): string =>
  `insert into ${schema}.migrations (sequence, filename, hash, previous_hash, status) values ($1, $2, $3, $4, '${status}')`;

const MARK_APPLIED = (schema: string): string =>
  `update ${schema}.migrations set status = 'applied', error = null where sequence = $1`;

const MARK_FAILED = (schema: string): string =>
  `update ${schema}.migrations set status = 'failed', error = $2 where sequence = $1`;

/** The writes to `migrations` rows; `schema` is the quoted schema name. */
function migrationRows(
  schema: string,
): Pick<TrackingSchema, "recordMigration" | "recordStarted" | "markApplied" | "markFailed"> {
  const insert =
    (status: "applied" | "started") =>
    async (session: Queryable, migration: ParsedMigration): Promise<void> => {
      await session.query(INSERT_MIGRATION(schema, status), [
        migration.sequence,
        migration.filename,
        migration.hash,
        migration.previous ?? null,
      ]);
    };
  return {
    recordMigration: insert("applied"),
    recordStarted: insert("started"),

    async markApplied(session, migration) {
      await session.query(MARK_APPLIED(schema), [migration.sequence]);
    },

    async markFailed(session, migration, error) {
      await session.query(MARK_FAILED(schema), [migration.sequence, error]);
    },
  };
}

async function readUnfinished(
  session: Queryable,
  schema: string,
): Promise<UnfinishedMigration | undefined> {
  const {
    rows: [row],
  } = await session.query(READ_LAST(schema));
  if (row === undefined || row["status"] === "applied") return undefined;
  const error: unknown = row["error"];
  return {
    sequence: Number(row["sequence"]),
    filename: String(row["filename"]),
    status: String(row["status"]),
    error: typeof error === "string" ? error : null,
  };
}

/** The first row's `hash` from `query`, or `undefined` when `table` (quoted, qualified) is missing or empty. */
async function readHash(
  session: Queryable,
  table: string,
  query: string,
): Promise<string | undefined> {
  const { rows } = (await tableExists(session, table)) ? await session.query(query) : { rows: [] };
  const hash: unknown = rows[0]?.["hash"];
  return typeof hash === "string" ? hash : undefined;
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
