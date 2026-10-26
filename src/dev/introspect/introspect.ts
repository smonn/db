import {
  DEFAULT_TRACKING_SCHEMA,
  trackingSchema,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import type { DriverRow, Queryable, Session } from "../../runtime/ports/index.ts";
import {
  catalogBuilder,
  type Catalog,
  type CatalogBuilder,
  type GeneratedPayload,
  type IdentityPayload,
} from "../catalog/index.ts";

const NOT_EXTENSION_MEMBER = (catalog: string, alias: string): string => `not exists (
  select from pg_depend d
  where d.classid = '${catalog}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e'
)`;

const KEPT_SCHEMA = `n.nspname !~ '^pg_' and n.nspname not in ('information_schema', $1)`;

const SCHEMAS = `
select n.nspname as name
from pg_namespace n
where ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_namespace", "n")}
order by n.nspname`;

/** Why `SCHEMAS` skips `schema`, or `undefined` when introspect reads it. */
export function skippedSchemaReason(
  schema: string,
  trackingName: string,
): "the tracking schema" | "a system schema" | undefined {
  if (schema === trackingName) return "the tracking schema";
  if (schema.startsWith("pg_") || schema === "information_schema") return "a system schema";
  return undefined;
}

const TABLES = `
select n.nspname as schema, c.relname as name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by c.relname`;

const COLUMNS = `
select n.nspname as schema, c.relname as table, a.attname as name,
  format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
  a.attidentity as identity, a.attgenerated as generated,
  case when a.attgenerated <> '' then pg_get_expr(d.adbin, d.adrelid) end as generation_expression,
  case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end as default_expression,
  case when a.attgenerated = '' then exists (
    select from regexp_matches(
      regexp_replace(pg_get_expr(d.adbin, d.adrelid), '''([^'']|'''')*''', '', 'g'),
      '([A-Za-z_][A-Za-z0-9_$]*|"[^"]+")\\s*\\(', 'g'
    ) as call(name)
      join pg_proc p on p.proname = trim(both '"' from call.name[1])
    where p.provolatile = 'v'
  ) end as default_volatile
from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and ${KEPT_SCHEMA}
order by a.attnum`;

// Multi-column unique constraints wait for v0.2, so only a single `conkey` entry counts. A
// deferrable, NULLS NOT DISTINCT, INCLUDE, or WITHOUT OVERLAPS key reads like a plain one, so it
// is skipped as an Unmodeled object (ADR-0005).
const CONSTRAINTS = `
select n.nspname as schema, c.relname as table, k.conname as name, k.contype as type,
  array(
    select a.attname::text
    from unnest(k.conkey) with ordinality as key(attnum, position)
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = key.attnum
    order by key.position
  ) as columns
from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_index i on i.indexrelid = k.conindid
where (k.contype = 'p' or (k.contype = 'u' and cardinality(k.conkey) = 1))
  and not k.condeferrable and not k.conperiod
  and not i.indnullsnotdistinct and i.indnkeyatts = i.indnatts
  and c.relkind = 'r' and not c.relispartition and ${KEPT_SCHEMA}
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by k.conname`;

/** The `pg_attribute.attidentity` codes; an empty string means no identity. */
const IDENTITY_KINDS: Readonly<Record<string, IdentityPayload["generated"]>> = {
  a: "always",
  d: "by default",
};

/** The `pg_attribute.attgenerated` codes; an empty string means not generated. */
const GENERATED_STORAGE: Readonly<Record<string, GeneratedPayload["storage"]>> = {
  s: "stored",
  v: "virtual",
};

/**
 * Reads the modeled objects of a live database in one snapshot, keyed by name. Skips system
 * schemas, the tracking schema, extension members, and every kind v0.1 doesn't model.
 */
export function introspect(
  session: Session,
  tracking: TrackingSchema = trackingSchema(DEFAULT_TRACKING_SCHEMA),
): Promise<Catalog> {
  return session.transaction(async (tx) => {
    await tx.execute("set transaction isolation level repeatable read read only");
    return introspectIn(tx, tracking);
  });
}

/**
 * `introspect` inside a transaction the caller already opened, such as one that renamed objects
 * and will roll back. It pins `search_path` for that transaction, so the caller runs its own
 * statements first.
 */
export async function introspectIn(
  tx: Queryable,
  tracking: TrackingSchema = trackingSchema(DEFAULT_TRACKING_SCHEMA),
): Promise<Catalog> {
  await tx.execute("set local search_path = pg_catalog");
  await requireSupportedServer(tx);
  return read(tx, tracking.name);
}

const MINIMUM_MAJOR_VERSION = 18;

/** Refuses a server older than the minimum Postgres major version, naming it. */
export async function requireSupportedServer(tx: Queryable): Promise<void> {
  const {
    rows: [row],
  } = await tx.query("select current_setting('server_version_num') as server_version_num");
  const major = Math.floor(Number(row?.["server_version_num"]) / 10_000);
  if (major >= MINIMUM_MAJOR_VERSION) return;
  throw new Error(
    `smonn/db needs Postgres ${MINIMUM_MAJOR_VERSION} or newer, and this server runs Postgres ${major}`,
  );
}

async function read(tx: Queryable, trackingName: string): Promise<Catalog> {
  const { rows: schemas } = await tx.query(SCHEMAS, [trackingName]);
  const { rows: tables } = await tx.query(TABLES, [trackingName]);
  const { rows: columns } = await tx.query(COLUMNS, [trackingName]);
  const { rows: constraints } = await tx.query(CONSTRAINTS, [trackingName]);

  const builder = catalogBuilder();
  for (const { name } of schemas) {
    const schema = String(name);
    builder.schema(schema);
    for (const table of tables.filter((row) => row["schema"] === schema)) {
      const tableName = String(table["name"]);
      builder.table(schema, tableName);
      for (const column of columns) {
        if (column["schema"] !== schema || column["table"] !== tableName) continue;
        addColumn(builder, schema, tableName, column);
      }
      for (const row of constraints) {
        if (row["schema"] !== schema || row["table"] !== tableName) continue;
        const constraint = String(row["name"]);
        const keyColumns = Array.isArray(row["columns"]) ? row["columns"].map(String) : [];
        if (row["type"] === "p")
          builder.primaryKey(schema, tableName, constraint, { columns: keyColumns });
        else builder.unique(schema, tableName, constraint, { column: keyColumns[0] ?? "" });
      }
    }
  }
  return builder.build();
}

function addColumn(
  builder: CatalogBuilder,
  schema: string,
  tableName: string,
  column: DriverRow,
): void {
  const columnName = String(column["name"]);
  // `attnotnull` is true for every Postgres 18 NOT NULL constraint row, valid or not.
  builder.column(schema, tableName, columnName, {
    type: String(column["type"]),
    notNull: column["not_null"] === true,
  });
  const identity = IDENTITY_KINDS[String(column["identity"])];
  if (identity !== undefined) {
    builder.columnIdentity(schema, tableName, columnName, { generated: identity });
  }
  const storage = GENERATED_STORAGE[String(column["generated"])];
  if (storage !== undefined) {
    builder.columnGenerated(schema, tableName, columnName, {
      expression: String(column["generation_expression"]),
      storage,
    });
  }
  if (typeof column["default_expression"] === "string") {
    builder.columnDefault(schema, tableName, columnName, {
      expression: column["default_expression"],
      volatile: column["default_volatile"] === true,
    });
  }
}
