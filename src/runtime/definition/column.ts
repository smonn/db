import type { Codec, RuntimeCodec } from "./codec.ts";
import type { Enum } from "./enum.ts";
import { columnIndexOf, type ColumnIndex, type IndexOptions } from "./index-options.ts";
import type { ColumnReference, ForeignKeyOptions, Target } from "./references.ts";

type Identity = "always" | "by default";

export type ColumnState = {
  /** Empty for an enum column, whose type is `enumType`. */
  readonly sqlType: string;
  /** The enum itself, since the rollup gives its type a name. */
  readonly enumType: Enum | undefined;
  /** True once `.array()` ran: a one-dimensional array of `sqlType` or `enumType`. */
  readonly array: boolean;
  /** True for a primary key or identity column too, as Postgres makes them. */
  readonly notNull: boolean;
  /** A SQL expression, written as it would follow `default` in DDL. */
  readonly default: string | undefined;
  readonly identity: Identity | undefined;
  /** True when `.primaryKey()` made this column the table's whole primary key. */
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** One entry per `.index()` call, in call order. */
  readonly indexes: readonly ColumnIndex[];
  /** The name `.primaryKey({ name })` or `.unique({ name })` gave its constraint. */
  readonly constraintName: string | undefined;
  /** The SQL name the column had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
  /** What `.references()` was given, apart from `constraintName`; `defineDatabase` resolves the target. */
  readonly references: ColumnReference | undefined;
};

/** Replaces the name Postgres would derive, such as `users_pkey` or `users_email_key`. */
type ConstraintOptions = { readonly name: string };

/**
 * `Int` is true for the types Postgres allows an identity on. `Gen` is true once the column has a
 * default or an identity, which Postgres allows only one of. `Pk` is true once `.primaryKey()` ran,
 * and `Key` once `.primaryKey()` or `.unique()` ran, since a primary key is already unique. `Fk` is
 * true once `.references()` ran. `Fresh` is true until a modifier (anything but `.renamedFrom()`)
 * or `.array()` ran, since `.array()` must come first.
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
  Fresh extends boolean = true,
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
  notNull(): Column<V, true, Int, Gen, Pk, Key, Co, Fk, false>;
  /**
   * Renames the column from `oldName`, its SQL name before this change. Generate ignores the
   * marker once the old name is gone, so remove it after the rename ships.
   */
  renamedFrom(oldName: string): Column<V, N, Int, Gen, Pk, Key, Co, Fk, Fresh>;
  /**
   * An index on this column alone. Call it again for a second index, giving each a name. An index
   * over several columns, or with more options, goes in the second callback's `indexes`.
   */
  index(options?: IndexOptions): Column<V, N, Int, Gen, Pk, Key, Co, Fk, Fresh>;
} & (Fresh extends true
  ? {
      /**
       * A one-dimensional array of this type, which reads as `(V | null)[]` since Postgres can't
       * make elements NOT NULL. Call it before any modifier, so `.notNull()` and `.default()` mean
       * the whole column. Postgres ignores declared dimensions, so there is no way to ask for more.
       */
      array(): Column<(V | null)[], false, false, false, false, false, false, false, false>;
    }
  : unknown) &
  (Co extends true
    ? unknown
    : {
        /** Overrides the TypeScript mapping; the query layer runs it and the catalog never sees it. A column takes one. */
        codec<Value>(codec: Codec<V, Value>): Column<Value, N, Int, Gen, Pk, Key, true, Fk, false>;
      }) &
  (Key extends true
    ? unknown
    : {
        /** The table's whole primary key. A composite key goes in `defineTable`'s second callback. */
        primaryKey(
          options?: ConstraintOptions,
        ): Column<V, true, Int, Gen, true, true, Co, Fk, false>;
        /** A unique constraint on this column alone. */
        unique(options?: ConstraintOptions): Column<V, N, Int, Gen, Pk, true, Co, Fk, false>;
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
        ): Column<V, N, Int, Gen, Pk, Key, Co, true, false>;
      }) &
  (Gen extends true
    ? unknown
    : {
        /** Takes a SQL expression, such as `now()`; a string literal needs its quotes (`"'new'"`). */
        default(expression: string): Column<V, N, Int, true, Pk, Key, Co, Fk, false>;
      } & (Int extends true
        ? {
            /** Generates the value from a sequence. */
            identity(generated?: Identity): Column<V, true, Int, true, Pk, Key, Co, Fk, false>;
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

export function column<
  V,
  N extends boolean,
  Int extends boolean,
  Gen extends boolean,
  Pk extends boolean,
  Key extends boolean,
  Co extends boolean,
  Fk extends boolean,
  Fresh extends boolean,
>(state: ColumnState, codec?: RuntimeCodec): Column<V, N, Int, Gen, Pk, Key, Co, Fk, Fresh> {
  const parts = {
    state,
    "~codec": codec,
    array: () => column({ ...state, array: true }, codec),
    notNull: () => column({ ...state, notNull: true }, codec),
    renamedFrom: (oldName: string) => column({ ...state, renamedFrom: oldName }, codec),
    index: (options?: IndexOptions) =>
      column({ ...state, indexes: [...state.indexes, columnIndexOf(options)] }, codec),
    default: (expression: string) => column({ ...state, default: expression }, codec),
    identity: (generated: Identity = "by default") =>
      column({ ...state, notNull: true, identity: generated }, codec),
    primaryKey: (options?: ConstraintOptions) =>
      column({ ...state, notNull: true, primaryKey: true, constraintName: options?.name }, codec),
    unique: (options?: ConstraintOptions) =>
      column({ ...state, unique: true, constraintName: options?.name }, codec),
    references: (target: ColumnReference["target"], options: ColumnReference["options"] = {}) =>
      column({ ...state, references: { target, options } }, codec),
    codec: (given: Codec<never, unknown>) => column(state, given as RuntimeCodec),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types, so `parts` doesn't overlap `Column` enough for a direct cast (TS2352); it goes through `unknown`.
  return parts as unknown as Column<V, N, Int, Gen, Pk, Key, Co, Fk, Fresh>;
}

export type Columns = Record<string, AnyColumn>;
