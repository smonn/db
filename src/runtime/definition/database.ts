import { casingOf, type DatabaseOptions } from "./casing.ts";
import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import { type ForeignKey, foreignKeysOf, placesOf, type Places } from "./foreign-keys.ts";
import { withSqlDefinition } from "./sql-definition.ts";
import { sqlNamesOf, type SqlNames } from "./sql-names.ts";
import type { Table, TableDefinition } from "./table.ts";

/** What a schema holds: tables, enums, and domains, which share one pool of names in Postgres. */
type SchemaEntry = TableDefinition | Enum | Domain;

type Schemas = Record<string, Record<string, SchemaEntry>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: S[Schema][Name] extends TableDefinition
      ? Table<
          S[Schema][Name]["columns"],
          S[Schema][Name]["primaryKey"][number],
          S[Schema][Name]["~keys"]
        >
      : S[Schema][Name];
  };
};

/** `foreignKeysOf` names a target by keys; this names it in SQL. */
function withSqlTarget(names: SqlNames, key: ForeignKey): ForeignKey {
  const { schema, table, columns } = key.target;
  const columnNames = names.columns(schema, table);
  const target = {
    schema: names.schema(schema),
    table: names.entry(schema, table),
    columns: columns.map((column) => columnNames[column] ?? column),
  };
  return { ...key, target };
}

/** `schema` and `name` are keys; the table and its foreign key targets take their SQL names. */
function tableOf(
  places: Places,
  names: SqlNames,
  [schema, name]: readonly [schema: string, name: string],
  definition: TableDefinition,
): Table {
  const { columns, primaryKey, declaredForeignKeys } = definition;
  const keyed = { columns, primaryKey, declaredForeignKeys };
  return {
    ...definition,
    schema: names.schema(schema),
    name: names.entry(schema, name),
    columnNames: names.columns(schema, name),
    foreignKeys: foreignKeysOf(places, schema, name, keyed).map((key) => withSqlTarget(names, key)),
  };
}

/**
 * Rolls up tables, enums, and domains under their schemas. Each key is its SQL name, unless
 * `options.casing` maps it or the entry gives its own; two keys that take one SQL name throw.
 */
export function defineDatabase<S extends Schemas>(
  schemas: S,
  options: DatabaseOptions = {},
): Database<S> {
  const names = sqlNamesOf(schemas, casingOf(options));
  const places = placesOf(schemas);
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, entry]) => [
          name,
          // A type stays the value its columns hold, since the catalog finds its name by identity.
          isEnum(entry) || isDomain(entry) ? entry : tableOf(places, names, [schema, name], entry),
        ]),
      ),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Object.fromEntries` types the result as string-indexed records, which don't overlap `Database<S>` enough for a direct cast (TS2352); it goes through `unknown`.
  return withSqlDefinition(database, names) as unknown as Database<S>;
}
