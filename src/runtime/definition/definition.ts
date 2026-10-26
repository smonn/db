import type { Columns } from "./column.ts";
import { isDomain, type Domain } from "./domain.ts";
import { isEnum, type Enum } from "./enum.ts";
import { type ColumnFactories, factories } from "./factories.ts";
import { type ForeignKey, foreignKeysOf, placesOf, type Places } from "./foreign-keys.ts";
import type { IndexEntry } from "./index-entries.ts";
import { indexesOf, type TableIndex } from "./indexes.ts";
import {
  keyColumns,
  refsOf,
  type RuntimeRefs,
  uniquesOf,
  type UniqueConstraint,
} from "./table-keys.ts";

/** A table without its name or schema, which `defineDatabase` gives it. */
export type TableDefinition<C extends Columns = Columns, K extends string = string> = {
  readonly columns: C;
  /** The primary key's columns in key order, empty without one. */
  readonly primaryKey: readonly K[];
  /** The primary key's constraint name when the Definition gives one; the catalog derives it otherwise. */
  readonly primaryKeyName: string | undefined;
  /** The unique constraints over two or more columns that the second callback declares. */
  readonly uniques: readonly UniqueConstraint[];
  /** The indexes the second callback declares; a column's `.index()` stays in its state. */
  readonly indexes: readonly TableIndex[];
  /** The SQL name the table had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
};

export type Table<C extends Columns = Columns, K extends string = string> = TableDefinition<
  C,
  K
> & {
  readonly schema: string;
  readonly name: string;
  /** The foreign keys its columns declare, with each target's table named. */
  readonly foreignKeys: readonly ForeignKey[];
};

type KeyedColumns<C extends Columns> = {
  [Name in keyof C & string]: C[Name]["~types"]["primaryKey"] extends true ? Name : never;
}[keyof C & string];

type IsUnion<T, U = T> = [T] extends [never]
  ? false
  : T extends unknown
    ? [U] extends [T]
      ? false
      : true
    : never;

/**
 * A reference to column `K` of the table with columns `C`, which table-level entries name instead of
 * a string. `"~table"` exists only in types; its function type holds `C` invariant, so a reference
 * from a table with other columns fails to compile.
 */
export type Ref<K extends string = string, C extends Columns = Columns> = {
  readonly "~ref": K;
  readonly "~table": (columns: C) => C;
};

/** The column references handed to a table's second callback, one per column key. */
export type ColumnRefs<C extends Columns> = { readonly [K in keyof C & string]: Ref<K, C> };

type OwnRef<C extends Columns> = Ref<keyof C & string, C>;

type KeyRefs<C extends Columns> = readonly [OwnRef<C>, OwnRef<C>, ...OwnRef<C>[]];

/** A composite key's columns, or its columns and the constraint name that replaces the derived one. */
type KeyEntry<C extends Columns> =
  | KeyRefs<C>
  | { readonly name: string; readonly columns: KeyRefs<C> };

/** A unique constraint over at least two columns; one column calls `unique()` instead. */
type UniqueEntry<C extends Columns> = {
  readonly columns: KeyRefs<C>;
  /** Replaces the derived name, `<table>_<columns joined by _>_key`. */
  readonly name?: string;
  /** Treats NULLs as equal, so two rows with the same columns and a NULL conflict. */
  readonly nullsNotDistinct?: boolean;
};

/** The table-level entries, keyed by kind. Later kinds (checks) join here. */
type TableExtras<C extends Columns> = {
  /** The table's SQL name before this change; generate ignores it once the old name is gone. */
  readonly renamedFrom?: string;
  readonly unique?: readonly UniqueEntry<C>[];
  readonly indexes?: readonly IndexEntry<OwnRef<C>>[];
} & ([KeyedColumns<C>] extends [never]
  ? { readonly primaryKey?: KeyEntry<C> }
  : { readonly primaryKey?: never });

/** The arguments after the columns; a misuse of the primary key leaves no argument list that fits. */
type ExtrasArgs<C extends Columns> =
  IsUnion<KeyedColumns<C>> extends true
    ? [
        extras: (t: ColumnRefs<C>) => {
          readonly primaryKey?: never;
          readonly "several columns call primaryKey(); declare a composite key in the second callback": never;
        },
      ]
    : [extras?: (t: ColumnRefs<C>) => TableExtras<C>];

type ListedRefs<Entry> = Entry extends { readonly columns: infer Listed } ? Listed : Entry;

type KeyOf<C extends Columns, Args extends unknown[]> = Args extends [
  (t: never) => { readonly primaryKey: infer Entry },
]
  ? ListedRefs<Entry> extends readonly Ref<infer K, C>[]
    ? K
    : never
  : KeyedColumns<C>;

type PrimaryKey = { readonly columns: string[]; readonly name: string | undefined };

function primaryKeyOf(columns: Columns, own: RuntimeRefs, declared: unknown): PrimaryKey {
  const single = Object.entries(columns).filter(([, { state }]) => state.primaryKey);
  if (declared === undefined) {
    if (single.length > 1) {
      throw new Error(
        `Columns ${single.map(([n]) => `"${n}"`).join(", ")} each call primaryKey(); declare a composite key in the table's second callback instead`,
      );
    }
    return { columns: single.map(([n]) => n), name: single[0]?.[1].state.constraintName };
  }
  if (single.length > 0) {
    throw new Error(
      `Column "${single[0]?.[0]}" calls primaryKey() and the table's second callback also declares a primary key; use one`,
    );
  }
  const entry = keyEntry(declared);
  return { columns: keyColumns(own, entry.columns, "primaryKey"), name: entry.name };
}

function keyEntry(declared: unknown): { name: string | undefined; columns: unknown } {
  if (Array.isArray(declared)) return { name: undefined, columns: declared };
  if (typeof declared === "object" && declared !== null && "name" in declared) {
    const { name } = declared;
    if (typeof name === "string")
      return { name, columns: "columns" in declared && declared.columns };
  }
  throw new TypeError("The table's primaryKey takes a list of columns or { name, columns }");
}

function renamedFromOf(declared: unknown): string | undefined {
  if (declared === undefined || typeof declared === "string") return declared;
  throw new TypeError("The table's renamedFrom takes the old SQL name as a string");
}

export function defineTable<C extends Columns, Args extends ExtrasArgs<C>>(
  define: (c: ColumnFactories) => C,
  ...args: Args
): TableDefinition<C, KeyOf<C, Args>> {
  const columns = define(factories);
  const extras:
    | ((t: ColumnRefs<C>) => {
        readonly primaryKey?: unknown;
        readonly unique?: unknown;
        readonly indexes?: unknown;
        readonly renamedFrom?: unknown;
      })
    | undefined = args[0];
  const own = refsOf(columns);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- refsOf builds one Ref per key; "~table" exists only in types.
  const declared = extras?.(own as unknown as ColumnRefs<C>);
  const primaryKey = primaryKeyOf(columns, own, declared?.primaryKey);
  const uniques = uniquesOf(own, declared?.unique);
  const indexes = indexesOf(own, declared?.indexes);
  const renamedFrom = renamedFromOf(declared?.renamedFrom);
  const both = Object.entries(columns).find(([, { state }]) => state.primaryKey && state.unique);
  if (both !== undefined) {
    throw new Error(
      `Column "${both[0]}" calls both primaryKey() and unique(); a primary key is already unique`,
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the key names are checked above.
  return {
    columns,
    primaryKey: primaryKey.columns,
    primaryKeyName: primaryKey.name,
    uniques,
    indexes,
    renamedFrom,
  } as unknown as TableDefinition<C, KeyOf<C, Args>>;
}

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
  { columns, primaryKey, primaryKeyName, uniques, indexes, renamedFrom }: TableDefinition,
): Table {
  return {
    schema,
    name,
    columns,
    primaryKey,
    primaryKeyName,
    uniques,
    indexes,
    renamedFrom,
    foreignKeys: foreignKeysOf(places, schema, name, columns),
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

type TypesOf<Col> = Col extends {
  readonly "~types": { readonly value: infer V; readonly notNull: infer N };
}
  ? { value: V; notNull: N }
  : never;

type ValueOf<Col, Keyed extends boolean = false> = Keyed extends true
  ? TypesOf<Col>["value"]
  : TypesOf<Col>["notNull"] extends true
    ? TypesOf<Col>["value"]
    : TypesOf<Col>["value"] | null;

/** The row type of table `T`, inferred from its columns. A driver's untyped result row is `DriverRow` in the ports module. */
export type Row<T extends TableDefinition> = {
  -readonly [K in keyof T["columns"]]: ValueOf<
    T["columns"][K],
    K extends T["primaryKey"][number] ? true : false
  >;
};
