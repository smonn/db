import { quoteIdentifier } from "../internal/index.ts";
import { casingOf, type DatabaseOptions } from "./casing.ts";
import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import { foreignKeysOf, placesOf, type Places } from "./foreign-keys.ts";
import { withSqlDefinition } from "./sql-definition.ts";
import { columnNamesOf, sqlNamesOf, type SqlNames } from "./sql-names.ts";
import type { Table, TableDefinition } from "./table.ts";

/** What a schema holds: tables, enums, and domains, which share one pool of names in Postgres. */
type SchemaEntry = TableDefinition | Enum | Domain;

type Schemas = Record<string, Record<string, SchemaEntry>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: S[Schema][Name] extends TableDefinition
      ? Table<S[Schema][Name]["columns"], S[Schema][Name]["primaryKey"][number]>
      : S[Schema][Name];
  };
};

type Naming = { readonly names: SqlNames; readonly cased: (key: string) => string };

/** `schema` and `name` are keys; the table takes their SQL names, and its foreign keys read keys. */
function tableOf(
  places: Places,
  { names, cased }: Naming,
  [schema, name]: readonly [schema: string, name: string],
  definition: TableDefinition,
): Table {
  const { columns, primaryKey, declaredForeignKeys } = definition;
  const sqlSchema = names.schema(schema);
  const sqlName = names.entry(schema, name);
  const where = `${quoteIdentifier(sqlSchema)}.${quoteIdentifier(sqlName)}`;
  return {
    ...definition,
    schema: sqlSchema,
    name: sqlName,
    columnNames: columnNamesOf(columns, cased, where),
    foreignKeys: foreignKeysOf(places, schema, name, { columns, primaryKey, declaredForeignKeys }),
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
  const cased = casingOf(options);
  const naming = { names: sqlNamesOf(schemas, cased), cased };
  const places = placesOf(schemas);
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, entry]) => [
          name,
          // A type stays the value its columns hold, since the catalog finds its name by identity.
          isEnum(entry) || isDomain(entry) ? entry : tableOf(places, naming, [schema, name], entry),
        ]),
      ),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Object.fromEntries` types the result as string-indexed records, which don't overlap `Database<S>` enough for a direct cast (TS2352); it goes through `unknown`.
  return withSqlDefinition(database, naming.names) as unknown as Database<S>;
}
