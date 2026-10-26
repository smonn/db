import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import { foreignKeysOf, placesOf, type Places } from "./foreign-keys.ts";
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

function tableOf(
  places: Places,
  schema: string,
  name: string,
  {
    columns,
    primaryKey,
    primaryKeyName,
    uniques,
    declaredForeignKeys,
    indexes,
    renamedFrom,
  }: TableDefinition,
): Table {
  return {
    schema,
    name,
    columns,
    primaryKey,
    primaryKeyName,
    uniques,
    declaredForeignKeys,
    indexes,
    renamedFrom,
    foreignKeys: foreignKeysOf(places, schema, name, { columns, primaryKey, declaredForeignKeys }),
  };
}

export function defineDatabase<S extends Schemas>(schemas: S): Database<S> {
  const places = placesOf(schemas);
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, entry]) => [
          name,
          // A type stays the value its columns hold, since the catalog finds its name by identity.
          isEnum(entry) || isDomain(entry) ? entry : tableOf(places, schema, name, entry),
        ]),
      ),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Object.fromEntries` types the result as string-indexed records, which don't overlap `Database<S>` enough for a direct cast (TS2352); it goes through `unknown`.
  return database as unknown as Database<S>;
}
