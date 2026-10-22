import {
  DEFAULT_TRACKING_SCHEMA,
  trackingSchema,
  type TrackingSchema,
} from "../../runtime/internal/index.ts";
import type { Queryable, Session } from "../../runtime/ports/index.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";

const NOT_EXTENSION_MEMBER = (catalog: string, alias: string): string => `not exists (
  select from pg_depend d
  where d.classid = '${catalog}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e'
)`;

const SCHEMAS = `
select n.nspname as name
from pg_namespace n
where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', $1)
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
where c.relkind = 'r' and not c.relispartition
  and ${NOT_EXTENSION_MEMBER("pg_class", "c")}
order by c.relname`;

const COLUMNS = `
select n.nspname as schema, c.relname as table, a.attname as name,
  format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
order by a.attnum`;

/**
 * Reads the modeled objects of a live database in one snapshot, keyed by name. Skips system
 * schemas, the tracking schema, extension members, and every kind v0.1 doesn't model.
 */
export function introspect(
  session: Session,
  tracking: TrackingSchema = trackingSchema(DEFAULT_TRACKING_SCHEMA),
): Promise<Catalog> {
  return session.transaction(async (tx) => {
    await tx.execute(
      "set transaction isolation level repeatable read read only; set local search_path = pg_catalog",
    );
    return read(tx, tracking.name);
  });
}

async function read(tx: Queryable, trackingName: string): Promise<Catalog> {
  const { rows: schemas } = await tx.query(SCHEMAS, [trackingName]);
  const { rows: tables } = await tx.query(TABLES);
  const { rows: columns } = await tx.query(COLUMNS);

  const builder = catalogBuilder();
  for (const { name } of schemas) {
    const schema = String(name);
    builder.schema(schema);
    for (const table of tables.filter((row) => row["schema"] === schema)) {
      const tableName = String(table["name"]);
      builder.table(schema, tableName);
      for (const column of columns) {
        if (column["schema"] !== schema || column["table"] !== tableName) continue;
        builder.column(schema, tableName, String(column["name"]), {
          type: String(column["type"]),
          notNull: column["not_null"] === true,
        });
      }
    }
  }
  return builder.build();
}
