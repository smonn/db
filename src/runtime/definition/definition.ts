import { type ColumnFactories, type Columns, factories } from "./column.ts";

/** A table without its name or schema, which `defineDatabase` gives it. */
export type TableDefinition<C extends Columns = Columns, K extends string = string> = {
  readonly columns: C;
  /** The primary key's columns in key order, empty without one. */
  readonly primaryKey: readonly K[];
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

/** A reference to a column of the table being defined, which table-level entries name instead of a string. */
export type Ref<K extends string = string> = { readonly "~ref": K };

/** The column references handed to a table's second callback, one per column key. */
export type Refs<C extends Columns> = { readonly [K in keyof C & string]: Ref<K> };

type KeyRefs<C extends Columns> = readonly [
  Ref<keyof C & string>,
  Ref<keyof C & string>,
  ...Ref<keyof C & string>[],
];

/** The table-level entries, keyed by kind. Later kinds (indexes, checks) join here. */
type TableExtras<C extends Columns> = [KeyedColumns<C>] extends [never]
  ? { readonly primaryKey?: KeyRefs<C> }
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

type KeyOf<C extends Columns, Args extends unknown[]> = Args extends [
  (t: never) => { readonly primaryKey: readonly Ref<infer K>[] },
]
  ? K
  : KeyedColumns<C>;

function refsOf(columns: Columns): Record<string, Ref> {
  return Object.fromEntries(Object.keys(columns).map((name) => [name, { "~ref": name }]));
}

function primaryKeyOf(columns: Columns, declared: unknown): string[] {
  const single = Object.entries(columns)
    .filter(([, { state }]) => state.primaryKey)
    .map(([name]) => name);
  if (declared === undefined) {
    if (single.length > 1) {
      throw new Error(
        `Columns ${single.map((n) => `"${n}"`).join(", ")} each call primaryKey(); declare a composite key in the table's second callback instead`,
      );
    }
    return single;
  }
  if (single.length > 0) {
    throw new Error(
      `Column "${single[0]}" calls primaryKey() and the table's second callback also declares a primary key; use one`,
    );
  }
  const refs: unknown[] = Array.isArray(declared) ? declared : [];
  if (refs.length < 2) {
    throw new Error(
      "The table's primaryKey lists fewer than two columns; call primaryKey() on the column instead",
    );
  }
  const keys: string[] = [];
  for (const ref of refs) {
    const name = typeof ref === "object" && ref !== null && "~ref" in ref ? ref["~ref"] : undefined;
    if (typeof name !== "string" || !Object.hasOwn(columns, name)) {
      throw new Error("The table's primaryKey names something that is not one of its columns");
    }
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- refsOf builds one Ref per key.
  const declared = extras?.(refsOf(columns) as Refs<C>);
  const primaryKey = primaryKeyOf(columns, declared?.primaryKey);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the key names are checked above.
  return { columns, primaryKey } as unknown as TableDefinition<C, KeyOf<C, Args>>;
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
        Object.entries(tables).map(([name, { columns, primaryKey }]) => [
          name,
          { schema, name, columns, primaryKey },
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
