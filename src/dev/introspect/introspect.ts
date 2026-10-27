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
  type ForeignKeyPayload,
  type GeneratedPayload,
  type IdentityPayload,
} from "../catalog/index.ts";
import { addIndex, indexColumns } from "./indexes.ts";
import { addDomains } from "./domains.ts";
import {
  COLUMNS,
  CONSTRAINTS,
  DOMAIN_CHECKS,
  DOMAINS,
  ENUMS,
  FOREIGN_KEYS,
  INDEXES,
  SCHEMAS,
  TABLES,
} from "./queries.ts";

/** Why `SCHEMAS` skips `schema`, or `undefined` when introspect reads it. */
export function skippedSchemaReason(
  schema: string,
  trackingName: string,
): "the tracking schema" | "a system schema" | undefined {
  if (schema === trackingName) return "the tracking schema";
  if (schema.startsWith("pg_") || schema === "information_schema") return "a system schema";
  return undefined;
}

/** The `pg_constraint.confdeltype` and `confupdtype` codes. */
const FOREIGN_KEY_ACTIONS: Readonly<Record<string, ForeignKeyPayload["onDelete"]>> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

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

type TableRows = {
  readonly columns: readonly DriverRow[];
  readonly constraints: readonly DriverRow[];
  readonly indexes: readonly DriverRow[];
  readonly foreignKeys: readonly DriverRow[];
};

async function read(tx: Queryable, trackingName: string): Promise<Catalog> {
  const { rows: schemas } = await tx.query(SCHEMAS, [trackingName]);
  const { rows: tables } = await tx.query(TABLES, [trackingName]);
  const { rows: enums } = await tx.query(ENUMS, [trackingName]);
  const { rows: domains } = await tx.query(DOMAINS, [trackingName]);
  const { rows: checks } = await tx.query(DOMAIN_CHECKS, [trackingName]);
  const { rows: columns } = await tx.query(COLUMNS, [trackingName]);
  const { rows: constraints } = await tx.query(CONSTRAINTS, [trackingName]);
  const { rows: indexes } = await tx.query(INDEXES, [trackingName]);
  const { rows: foreignKeys } = await tx.query(FOREIGN_KEYS, [trackingName]);
  const rows = {
    columns,
    constraints: onModeledColumns(constraints, columns),
    indexes: onModeledColumns(indexes, columns, indexColumns),
    foreignKeys: onModeledColumns(modeledForeignKeys(foreignKeys, schemas, tables), columns),
  };

  const builder = catalogBuilder();
  for (const { name } of schemas) {
    const schema = String(name);
    builder.schema(schema);
    for (const type of enums.filter((row) => row["schema"] === schema)) {
      const labels = Array.isArray(type["labels"]) ? type["labels"].map(String) : [];
      builder.enumType(schema, String(type["name"]), { labels });
    }
    addDomains(builder, schema, { domains, checks });
    for (const table of tables.filter((row) => row["schema"] === schema)) {
      addTable(builder, schema, String(table["name"]), rows);
    }
  }
  return builder.build();
}

/** Drops a foreign key to a table this read skips, such as a partitioned one: it is Unmodeled. */
function modeledForeignKeys(
  foreignKeys: readonly DriverRow[],
  schemas: readonly DriverRow[],
  tables: readonly DriverRow[],
): DriverRow[] {
  const modeled = new Set(
    tables
      .filter((table) => schemas.some(({ name }) => name === table["schema"]))
      .map((table) => `${String(table["schema"])}\0${String(table["name"])}`),
  );
  return foreignKeys.filter((row) =>
    modeled.has(`${String(row["target_schema"])}\0${String(row["target_table"])}`),
  );
}

/** Drops a key that names a column `COLUMNS` skips, such as an array of a range: it is Unmodeled. */
function onModeledColumns(
  keys: readonly DriverRow[],
  columns: readonly DriverRow[],
  columnsOf: (row: DriverRow) => string[] = (row) => names(row["columns"]),
): DriverRow[] {
  const modeled = new Set(
    columns.map(
      (row) => `${String(row["schema"])}\0${String(row["table"])}\0${String(row["name"])}`,
    ),
  );
  return keys.filter((row) =>
    columnsOf(row).every((column) =>
      modeled.has(`${String(row["schema"])}\0${String(row["table"])}\0${column}`),
    ),
  );
}

function addTable(
  builder: CatalogBuilder,
  schema: string,
  tableName: string,
  rows: TableRows,
): void {
  builder.table(schema, tableName);
  const here = (row: DriverRow): boolean => row["schema"] === schema && row["table"] === tableName;
  for (const column of rows.columns.filter(here)) addColumn(builder, schema, tableName, column);
  for (const row of rows.constraints.filter(here)) addKey(builder, schema, tableName, row);
  for (const row of rows.indexes.filter(here)) addIndex(builder, schema, tableName, row);
  for (const row of rows.foreignKeys.filter(here)) addForeignKey(builder, schema, tableName, row);
}

function addKey(builder: CatalogBuilder, schema: string, tableName: string, row: DriverRow): void {
  const constraint = String(row["name"]);
  const keyColumns = names(row["columns"]);
  if (row["type"] === "p") {
    builder.primaryKey(schema, tableName, constraint, { columns: keyColumns });
  } else {
    builder.unique(schema, tableName, constraint, {
      columns: keyColumns,
      nullsNotDistinct: row["nulls_not_distinct"] === true,
    });
  }
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function addForeignKey(
  builder: CatalogBuilder,
  schema: string,
  tableName: string,
  row: DriverRow,
): void {
  builder.foreignKey(schema, tableName, String(row["name"]), {
    columns: names(row["columns"]),
    target: {
      schema: String(row["target_schema"]),
      table: String(row["target_table"]),
      columns: names(row["target_columns"]),
    },
    onDelete: FOREIGN_KEY_ACTIONS[String(row["on_delete"])] ?? "no action",
    onUpdate: FOREIGN_KEY_ACTIONS[String(row["on_update"])] ?? "no action",
    // `confmatchtype` is `f` or `s`; Postgres has no `MATCH PARTIAL`.
    match: row["match"] === "f" ? "full" : "simple",
    deferrable: deferrableOf(row),
  });
}

function deferrableOf(row: DriverRow): ForeignKeyPayload["deferrable"] {
  if (row["deferrable"] !== true) return "not deferrable";
  return row["deferred"] === true ? "deferred" : "immediate";
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
    builder.columnIdentity(schema, tableName, columnName, {
      generated: identity,
      sequence: String(column["identity_sequence"]),
    });
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
