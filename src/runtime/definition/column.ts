import type { Codec, RuntimeCodec } from "./codec.ts";

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
  /** The name `.primaryKey({ name })` or `.unique({ name })` gave its constraint. */
  readonly constraintName: string | undefined;
  /** What `.references()` was given, apart from `constraintName`; `defineDatabase` resolves the target. */
  readonly references: ColumnReference | undefined;
};

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export type ForeignKeyOptions = {
  /** Replaces the name Postgres would derive, `<table>_<column>_fkey`. */
  readonly name?: string;
  /** Defaults to `"no action"`. */
  readonly onDelete?: ForeignKeyAction;
  /** Defaults to `"no action"`. */
  readonly onUpdate?: ForeignKeyAction;
  /** Makes the constraint `DEFERRABLE` with this initial mode; without it the constraint is not deferrable. */
  readonly deferrable?: "immediate" | "deferred";
};

/** A column's foreign key before `defineDatabase` finds the table its target belongs to. */
export type ColumnReference = {
  /** A thunk, so tables in two files that import each other load in either order. */
  readonly target: () => Target<unknown>;
  readonly options: ForeignKeyOptions;
};

/** What a foreign key may point at: a primary key or unique column holding a `V`. */
export type Target<V> = {
  readonly state: ColumnState;
  readonly "~types": {
    readonly value: V;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
    readonly key: true;
  };
};

/** Replaces the name Postgres would derive, such as `users_pkey` or `users_email_key`. */
type ConstraintOptions = { readonly name: string };

/**
 * `Int` is true for the types Postgres allows an identity on. `Gen` is true once the column has a
 * default or an identity, which Postgres allows only one of. `Pk` is true once `.primaryKey()` ran,
 * and `Key` once `.primaryKey()` or `.unique()` ran, since a primary key is already unique. `Fk` is
 * true once `.references()` ran.
 */
export type Column<
  V,
  N extends boolean = false,
  Int extends boolean = false,
  Gen extends boolean = false,
  Pk extends boolean = false,
  Key extends boolean = false,
  Co extends boolean = false,
  Fk extends boolean = false,
> = {
  readonly state: ColumnState;
  /** Runtime-only: the codec `.codec()` set. It stays out of `state`, so it never reaches the catalog. */
  readonly "~codec": RuntimeCodec | undefined;
  /** Type-only: the value a row holds, whether the column is NOT NULL, the primary key, or a key a foreign key may point at. */
  readonly "~types": {
    readonly value: V;
    readonly notNull: N;
    readonly primaryKey: Pk;
    readonly key: Key;
  };
  notNull(): Column<V, true, Int, Gen, Pk, Key, Co, Fk>;
} & (Co extends true
  ? unknown
  : {
      /** Overrides the TypeScript mapping; the query layer runs it and the catalog never sees it. A column takes one. */
      codec<Value>(codec: Codec<V, Value>): Column<Value, N, Int, Gen, Pk, Key, true, Fk>;
    }) &
  (Key extends true
    ? unknown
    : {
        /** The table's whole primary key. A composite key goes in `defineTable`'s second callback. */
        primaryKey(options?: ConstraintOptions): Column<V, true, Int, Gen, true, true, Co, Fk>;
        /** A unique constraint on this column alone. */
        unique(options?: ConstraintOptions): Column<V, N, Int, Gen, Pk, true, Co, Fk>;
      }) &
  (Fk extends true
    ? unknown
    : {
        /**
         * A foreign key to another table's primary key or unique column holding the same value. The
         * thunk reads the target late; two tables that point at each other need one thunk to name
         * its type, such as `(): Target<number> => orders.columns.id`.
         */
        references(
          target: () => Target<V>,
          options?: ForeignKeyOptions,
        ): Column<V, N, Int, Gen, Pk, Key, Co, true>;
      }) &
  (Gen extends true
    ? unknown
    : {
        /** Takes a SQL expression, such as `now()`; a string literal needs its quotes (`"'new'"`). */
        default(expression: string): Column<V, N, Int, true, Pk, Key, Co, Fk>;
      } & (Int extends true
        ? {
            /** Generates the value from a sequence. */
            identity(generated?: Identity): Column<V, true, Int, true, Pk, Key, Co, Fk>;
          }
        : unknown));

/** A column of any kind, which is all a table needs to read. */
type AnyColumn = {
  readonly state: ColumnState;
  readonly "~codec": RuntimeCodec | undefined;
  readonly "~types": {
    readonly value: unknown;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
    readonly key: boolean;
  };
};

function column<
  V,
  N extends boolean,
  Int extends boolean,
  Gen extends boolean,
  Pk extends boolean,
  Key extends boolean,
  Co extends boolean,
  Fk extends boolean,
>(state: ColumnState, codec?: RuntimeCodec): Column<V, N, Int, Gen, Pk, Key, Co, Fk> {
  const parts = {
    state,
    "~codec": codec,
    notNull: () => column({ ...state, notNull: true }, codec),
    default: (expression: string) => column({ ...state, default: expression }, codec),
    identity: (generated: Identity = "by default") =>
      column({ ...state, notNull: true, identity: generated }, codec),
    primaryKey: (options?: ConstraintOptions) =>
      column({ ...state, notNull: true, primaryKey: true, constraintName: options?.name }, codec),
    unique: (options?: ConstraintOptions) =>
      column({ ...state, unique: true, constraintName: options?.name }, codec),
    references: (target: () => Target<unknown>, options: ForeignKeyOptions = {}) =>
      column({ ...state, references: { target, options } }, codec),
    codec: (given: Codec<never, unknown>) => column(state, given as RuntimeCodec),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types, so `parts` doesn't overlap `Column` enough for a direct cast (TS2352); it goes through `unknown`.
  return parts as unknown as Column<V, N, Int, Gen, Pk, Key, Co, Fk>;
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
  return column<V, false, Int, false, false, false, false, false>({
    sqlType,
    notNull: false,
    default: undefined,
    identity: undefined,
    primaryKey: false,
    unique: false,
    constraintName: undefined,
    references: undefined,
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
