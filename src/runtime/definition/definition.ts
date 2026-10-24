import { type ColumnFactories, type Columns, factories } from "./column.ts";

/** A table without its name or schema, which `defineDatabase` gives it. */
export type TableDefinition<C extends Columns = Columns, K extends string = string> = {
  readonly columns: C;
  /** The primary key's columns in key order, empty without one. */
  readonly primaryKey: readonly K[];
  /** The primary key's constraint name when the Definition gives one; the catalog derives it otherwise. */
  readonly primaryKeyName: string | undefined;
};

export type Table<C extends Columns = Columns, K extends string = string> = TableDefinition<
  C,
  K
> & {
  readonly schema: string;
  readonly name: string;
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
export type Refs<C extends Columns> = { readonly [K in keyof C & string]: Ref<K, C> };

type OwnRef<C extends Columns> = Ref<keyof C & string, C>;

type KeyRefs<C extends Columns> = readonly [OwnRef<C>, OwnRef<C>, ...OwnRef<C>[]];

/** A composite key's columns, or its columns and the constraint name that replaces the derived one. */
type KeyEntry<C extends Columns> =
  | KeyRefs<C>
  | { readonly name: string; readonly columns: KeyRefs<C> };

/** The table-level entries, keyed by kind. Later kinds (indexes, checks) join here. */
type TableExtras<C extends Columns> = [KeyedColumns<C>] extends [never]
  ? { readonly primaryKey?: KeyEntry<C> }
  : { readonly primaryKey?: never };

/** The arguments after the columns; a misuse of the primary key leaves no argument list that fits. */
type ExtrasArgs<C extends Columns> =
  IsUnion<KeyedColumns<C>> extends true
    ? [
        extras: (t: Refs<C>) => {
          readonly primaryKey?: never;
          readonly "several columns call primaryKey(); declare a composite key in the second callback": never;
        },
      ]
    : [extras?: (t: Refs<C>) => TableExtras<C>];

type ListedRefs<Entry> = Entry extends { readonly columns: infer Listed } ? Listed : Entry;

type KeyOf<C extends Columns, Args extends unknown[]> = Args extends [
  (t: never) => { readonly primaryKey: infer Entry },
]
  ? ListedRefs<Entry> extends readonly Ref<infer K, C>[]
    ? K
    : never
  : KeyedColumns<C>;

/** A `Ref` as it exists at runtime; one table's references are told from another's by identity. */
type RuntimeRefs = Readonly<Record<string, { readonly "~ref": string }>>;

function refsOf(columns: Columns): RuntimeRefs {
  return Object.fromEntries(Object.keys(columns).map((name) => [name, { "~ref": name }]));
}

/** The column key `ref` names, once it proves to be one of this table's own references. */
function columnOf(own: RuntimeRefs, ref: unknown, entry: string): string {
  const name = typeof ref === "object" && ref !== null && "~ref" in ref ? ref["~ref"] : undefined;
  if (typeof name !== "string") {
    throw new TypeError(`The table's ${entry} names something that is not one of its columns`);
  }
  if (own[name] !== ref) {
    throw new Error(
      `The table's ${entry} takes "${name}" from another table; name columns through the references its own second callback receives`,
    );
  }
  return name;
}

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
  return { columns: keyColumns(own, entry.columns), name: entry.name };
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

function keyColumns(own: RuntimeRefs, declared: unknown): string[] {
  const refs: unknown[] = Array.isArray(declared) ? declared : [];
  if (refs.length < 2) {
    throw new Error(
      "The table's primaryKey lists fewer than two columns; call primaryKey() on the column instead",
    );
  }
  const keys: string[] = [];
  for (const ref of refs) {
    const name = columnOf(own, ref, "primaryKey");
    if (keys.includes(name)) {
      throw new Error(`The table's primaryKey lists "${name}" twice`);
    }
    keys.push(name);
  }
  return keys;
}

export function defineTable<C extends Columns, Args extends ExtrasArgs<C>>(
  define: (c: ColumnFactories) => C,
  ...args: Args
): TableDefinition<C, KeyOf<C, Args>> {
  const columns = define(factories);
  const extras: ((t: Refs<C>) => { readonly primaryKey?: unknown }) | undefined = args[0];
  const own = refsOf(columns);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- refsOf builds one Ref per key; "~table" exists only in types.
  const declared = extras?.(own as unknown as Refs<C>);
  const primaryKey = primaryKeyOf(columns, own, declared?.primaryKey);
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
  } as unknown as TableDefinition<C, KeyOf<C, Args>>;
}

type Schemas = Record<string, Record<string, TableDefinition>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: Table<
      S[Schema][Name]["columns"],
      S[Schema][Name]["primaryKey"][number]
    >;
  };
};

export function defineDatabase<S extends Schemas>(schemas: S): Database<S> {
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, { columns, primaryKey, primaryKeyName }]) => [
          name,
          { schema, name, columns, primaryKey, primaryKeyName },
        ]),
      ),
    ]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  return database as Database<S>;
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
