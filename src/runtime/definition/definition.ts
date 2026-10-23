type Identity = "always" | "by default";

export type ColumnState = {
  readonly sqlType: string;
  /** True for a primary key or identity column too, as Postgres makes them. */
  readonly notNull: boolean;
  /** A SQL expression, written as it would follow `default` in DDL. */
  readonly default: string | undefined;
  readonly identity: Identity | undefined;
  /** True when `.primaryKey()` made this column the table's whole primary key. */
  readonly primaryKey: boolean;
  readonly unique: boolean;
};

/**
 * `Int` is true for the types Postgres allows an identity on. `Gen` is true once the column has a
 * default or an identity, which Postgres allows only one of. `Pk` is true once `.primaryKey()` ran.
 */
export type Column<
  V,
  N extends boolean = false,
  Int extends boolean = false,
  Gen extends boolean = false,
  Pk extends boolean = false,
> = {
  readonly state: ColumnState;
  /** Type-only: the value a row holds, whether the column is NOT NULL, and whether it is the primary key. */
  readonly "~types": { readonly value: V; readonly notNull: N; readonly primaryKey: Pk };
  notNull(): Column<V, true, Int, Gen, Pk>;
  /** A unique constraint on this column alone. */
  unique(): Column<V, N, Int, Gen, Pk>;
} & (Pk extends true
  ? unknown
  : {
      /** The table's whole primary key. A composite key goes in `defineTable`'s options. */
      primaryKey(): Column<V, true, Int, Gen, true>;
    }) &
  (Gen extends true
    ? unknown
    : {
        /** Takes a SQL expression, such as `now()`; a string literal needs its quotes (`"'new'"`). */
        default(expression: string): Column<V, N, Int, true, Pk>;
      } & (Int extends true
        ? {
            /** Generates the value from a sequence. */
            identity(generated?: Identity): Column<V, true, Int, true, Pk>;
          }
        : unknown));

/** A column of any kind, which is all a table needs to read. */
type AnyColumn = {
  readonly state: ColumnState;
  readonly "~types": {
    readonly value: unknown;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
  };
};

function column<V, N extends boolean, Int extends boolean, Gen extends boolean, Pk extends boolean>(
  state: ColumnState,
): Column<V, N, Int, Gen, Pk> {
  const parts = {
    state,
    notNull: () => column({ ...state, notNull: true }),
    default: (expression: string) => column({ ...state, default: expression }),
    identity: (generated: Identity = "by default") =>
      column({ ...state, notNull: true, identity: generated }),
    primaryKey: () => column({ ...state, notNull: true, primaryKey: true }),
    unique: () => column({ ...state, unique: true }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types.
  return parts as unknown as Column<V, N, Int, Gen, Pk>;
}

export type ColumnFactories = {
  readonly text: () => Column<string>;
  readonly varchar: (length: number) => Column<string>;
  readonly smallint: () => Column<number, false, true>;
  readonly integer: () => Column<number, false, true>;
  readonly bigint: () => Column<bigint, false, true>;
  /** Without a precision the column holds any number of digits. */
  readonly numeric: (precision?: number, scale?: number) => Column<string>;
  readonly real: () => Column<number>;
  readonly doublePrecision: () => Column<number>;
  readonly boolean: () => Column<boolean>;
  readonly uuid: () => Column<string>;
  readonly date: () => Column<string>;
  readonly timestamp: () => Column<Date>;
  readonly timestamptz: () => Column<Date>;
  readonly jsonb: <T = unknown>() => Column<T>;
  readonly bytea: () => Column<Uint8Array>;
};

function of<V, Int extends boolean = false>(sqlType: string): Column<V, false, Int> {
  return column<V, false, Int, false, false>({
    sqlType,
    notNull: false,
    default: undefined,
    identity: undefined,
    primaryKey: false,
    unique: false,
  });
}

function numericType(precision?: number, scale?: number): string {
  if (precision === undefined) return "numeric";
  return scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
}

const factories: ColumnFactories = {
  text: () => of("text"),
  varchar: (length) => of(`varchar(${length})`),
  smallint: () => of("smallint"),
  integer: () => of("integer"),
  bigint: () => of("bigint"),
  numeric: (precision, scale) => of(numericType(precision, scale)),
  real: () => of("real"),
  doublePrecision: () => of("double precision"),
  boolean: () => of("boolean"),
  uuid: () => of("uuid"),
  date: () => of("date"),
  timestamp: () => of("timestamp"),
  timestamptz: () => of("timestamptz"),
  jsonb: () => of("jsonb"),
  bytea: () => of("bytea"),
};

export type Columns = Record<string, AnyColumn>;

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

/** The arguments after the callback; a misuse of the primary key leaves no argument list that fits. */
type PrimaryKeyArgs<C extends Columns> = [KeyedColumns<C>] extends [never]
  ? [
      options?: {
        readonly primaryKey?: readonly [
          keyof C & string,
          keyof C & string,
          ...(keyof C & string)[],
        ];
      },
    ]
  : IsUnion<KeyedColumns<C>> extends true
    ? [
        options: {
          readonly "several columns call primaryKey(); declare a composite key in options": never;
        },
      ]
    : [options?: { readonly primaryKey?: never }];

type KeyOf<C extends Columns, Args extends unknown[]> = Args extends [
  { readonly primaryKey: readonly (infer K extends string)[] },
]
  ? K
  : KeyedColumns<C>;

function primaryKeyOf(columns: Columns, declared: unknown): string[] {
  const single = Object.entries(columns)
    .filter(([, { state }]) => state.primaryKey)
    .map(([name]) => name);
  if (!Array.isArray(declared)) {
    if (single.length > 1) {
      throw new Error(
        `Columns ${single.map((n) => `"${n}"`).join(", ")} each call primaryKey(); declare a composite key in the table options instead`,
      );
    }
    return single;
  }
  const names: unknown[] = declared;
  if (single.length > 0) {
    throw new Error(
      `Column "${single[0]}" calls primaryKey() and the table options also declare a primary key; use one`,
    );
  }
  if (names.length < 2) {
    throw new Error(
      "The table options' primaryKey lists fewer than two columns; call primaryKey() on the column instead",
    );
  }
  const keys: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !Object.hasOwn(columns, name)) {
      throw new Error(
        `The table options' primaryKey names "${String(name)}", which is not a column`,
      );
    }
    if (keys.includes(name)) {
      throw new Error(`The table options' primaryKey lists "${name}" twice`);
    }
    keys.push(name);
  }
  return keys;
}

export function defineTable<C extends Columns, Args extends PrimaryKeyArgs<C>>(
  define: (c: ColumnFactories) => C,
  ...args: Args
): TableDefinition<C, KeyOf<C, Args>> {
  const columns = define(factories);
  const options: unknown = args[0];
  const declared =
    typeof options === "object" && options !== null && "primaryKey" in options
      ? options.primaryKey
      : undefined;
  const primaryKey = primaryKeyOf(columns, declared);
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
