type Identity = "always" | "by default";

export type ColumnState = {
  readonly sqlType: string;
  /** True for a primary key or identity column too, as Postgres makes them. */
  readonly notNull: boolean;
  /** A SQL expression, written as it would follow `default` in DDL. */
  readonly default: string | undefined;
  readonly identity: Identity | undefined;
  /** Columns that declare it form the primary key, in column order. */
  readonly primaryKey: boolean;
  readonly unique: boolean;
};

/**
 * `Int` is true for the types Postgres allows an identity on. `Gen` is true once the column has a
 * default or an identity, which Postgres allows only one of.
 */
export type Column<
  V,
  N extends boolean = false,
  Int extends boolean = false,
  Gen extends boolean = false,
> = {
  readonly state: ColumnState;
  /** Type-only: the value a row holds and whether the column is NOT NULL. */
  readonly "~types": { readonly value: V; readonly notNull: N };
  notNull(): Column<V, true, Int, Gen>;
  /** Several primary key columns make a composite key, in column order. */
  primaryKey(): Column<V, true, Int, Gen>;
  /** A single-column unique constraint. */
  unique(): Column<V, N, Int, Gen>;
} & (Gen extends true
  ? unknown
  : {
      /** Takes a SQL expression, such as `now()`; a string literal needs its quotes (`"'new'"`). */
      default(expression: string): Column<V, N, Int, true>;
    } & (Int extends true
      ? {
          /** Generates the value from a sequence. */
          identity(generated?: Identity): Column<V, true, Int, true>;
        }
      : unknown));

/** A column of any kind, which is all a table needs to read. */
type AnyColumn = {
  readonly state: ColumnState;
  readonly "~types": { readonly value: unknown; readonly notNull: boolean };
};

function column<V, N extends boolean, Int extends boolean, Gen extends boolean>(
  state: ColumnState,
): Column<V, N, Int, Gen> {
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
  return parts as unknown as Column<V, N, Int, Gen>;
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
  return column<V, false, Int, false>({
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
export type TableDefinition<C extends Columns = Columns> = {
  readonly columns: C;
};

export type Table<C extends Columns = Columns> = TableDefinition<C> & {
  readonly schema: string;
  readonly name: string;
};

export function defineTable<C extends Columns>(
  define: (c: ColumnFactories) => C,
): TableDefinition<C> {
  return { columns: define(factories) };
}

type Schemas = Record<string, Record<string, TableDefinition>>;

export type Database<S extends Schemas> = {
  readonly [Schema in keyof S]: {
    readonly [Name in keyof S[Schema]]: Table<S[Schema][Name]["columns"]>;
  };
};

export function defineDatabase<S extends Schemas>(schemas: S): Database<S> {
  const database = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, { columns }]) => [name, { schema, name, columns }]),
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

type ValueOf<Col> = TypesOf<Col>["notNull"] extends true
  ? TypesOf<Col>["value"]
  : TypesOf<Col>["value"] | null;

/** The row type of table `T`, inferred from its columns. A driver's untyped result row is `DriverRow` in the ports module. */
export type Row<T extends TableDefinition> = {
  -readonly [K in keyof T["columns"]]: ValueOf<T["columns"][K]>;
};
