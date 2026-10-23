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
      /** The table's whole primary key. A composite key goes in `defineTable`'s second callback. */
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types, so `parts` doesn't overlap `Column` enough for a direct cast (TS2352); it goes through `unknown`.
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

export const factories: ColumnFactories = {
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
