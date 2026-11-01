import type { Codec, RuntimeCodec } from "./codec.ts";
import type { Domain } from "./domain.ts";
import type { Enum } from "./enum.ts";
import { columnIndexOf, type ColumnIndex, type IndexOptions } from "./index-options.ts";
import type { ScalarClass, SqlClass } from "./sql-class.ts";
import type { ColumnReference, ForeignKeyOptions, Target } from "./references.ts";

type Identity = "always" | "by default";

export type ColumnState = {
  /** Empty for an enum or domain column, whose type is `enumType` or `domainType`. */
  readonly sqlType: string;
  /** The enum itself, since the rollup gives its type a name. */
  readonly enumType: Enum | undefined;
  /** The domain itself, named by the rollup like an enum. */
  readonly domainType: Domain | undefined;
  /** True once `.array()` ran: a one-dimensional array of the column's type. */
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
  /** The SQL name `.name()` gave, which wins over the casing `defineDatabase` maps keys with. */
  readonly explicitName: string | undefined;
  /** The SQL name the column had before a rename, for generate to turn into a `RENAME`. */
  readonly renamedFrom: string | undefined;
  /** What `.references()` was given, apart from `constraintName`; `defineDatabase` resolves the target. */
  readonly references: ColumnReference | undefined;
};

/** Replaces the name Postgres would derive, such as `users_pkey` or `users_email_key`. */
type ConstraintOptions = { readonly name: string };

/**
 * What a column's type knows about its modifiers, one key each, so an error names every flag. The
 * keys aren't `readonly`, since the flags exist only in types and the modifier would lengthen
 * every error.
 */
export type ColumnFlags = {
  /** True for a primary key, an identity, or a NOT NULL domain too, as Postgres makes them. */
  notNull: boolean;
  /** True for the types Postgres allows an identity on. */
  int: boolean;
  /** Which types the column compares and matches with; a domain has its base's. */
  sqlClass: SqlClass;
  /** True once the column has a default or an identity, which Postgres allows only one of. */
  generated: boolean;
  /** True once `.primaryKey()` ran. */
  primaryKey: boolean;
  /** True once `.primaryKey()` or `.unique()` ran, since a primary key is already unique. */
  key: boolean;
  /** True once `.codec()` ran, since a column takes one. */
  codec: boolean;
  /** True once `.references()` ran. */
  references: boolean;
  /**
   * True until a modifier (anything but `.name()`, `.renamedFrom()`, `.index()`, and `.codec()`)
   * or `.array()` ran, since `.array()` must come first.
   */
  fresh: boolean;
};

/**
 * The flags of a column no modifier has touched, of a type that takes no identity. A factory
 * narrows `sqlClass`.
 */
export type FreshFlags = {
  notNull: false;
  int: false;
  sqlClass: SqlClass;
  generated: false;
  primaryKey: false;
  key: false;
  codec: false;
  references: false;
  fresh: true;
};

/**
 * `F` with the keys `P` sets replaced. The conditional makes errors print the resulting object
 * rather than nested `WithFlags<...>` names.
 */
export type WithFlags<F extends ColumnFlags, P extends Partial<ColumnFlags>> = F extends unknown
  ? { [K in keyof ColumnFlags]: K extends keyof P ? P[K] : F[K] }
  : never;

/** `V` is the value a row holds; `F` says which modifiers ran, and so which remain. */
export type Column<V, F extends ColumnFlags = FreshFlags> = {
  readonly state: ColumnState;
  /** Runtime-only: the codec `.codec()` set. It stays out of `state`, so it never reaches the catalog. */
  readonly "~codec": RuntimeCodec | undefined;
  /** Type-only: the value a row holds, whether the column is NOT NULL, has a default or an identity, is the primary key, or is a key a foreign key may point at, and its SQL type class. */
  readonly "~types": {
    readonly value: V;
    readonly sqlClass: F["sqlClass"];
    readonly notNull: F["notNull"];
    readonly generated: F["generated"];
    readonly primaryKey: F["primaryKey"];
    readonly key: F["key"];
  };
  notNull(): Column<V, WithFlags<F, { notNull: true; fresh: false }>>;
  /**
   * Renames the column from `oldName`, its SQL name before this change. Generate ignores the
   * marker once the old name is gone, so remove it after the rename ships.
   */
  renamedFrom(oldName: string): Column<V, F>;
  /** Gives the column this SQL name in place of its key, for a name casing can't produce. */
  name(sqlName: string): Column<V, F>;
  /**
   * An index on this column alone. Call it again for a second index, giving each a name. An index
   * over several columns, or with more options, goes in the second callback's `indexes`.
   */
  index(options?: IndexOptions): Column<V, F>;
} & (F["fresh"] extends true
  ? {
      /**
       * A one-dimensional array of this type, which reads as `(V | null)[]` since Postgres can't
       * make elements NOT NULL. Call it before any modifier, so `.notNull()` and `.default()` mean
       * the whole column. Postgres ignores declared dimensions, so there is no way to ask for more.
       * A `.codec()` before it runs on each element, and none is offered after it.
       */
      array(): Column<
        (V | null)[],
        WithFlags<
          FreshFlags,
          { sqlClass: `${Extract<F["sqlClass"], ScalarClass>}[]`; codec: true; fresh: false }
        >
      >;
    }
  : unknown) &
  (F["codec"] extends true
    ? unknown
    : {
        /**
         * Overrides the TypeScript mapping; the query layer runs it and the catalog never sees it. A
         * column takes one. Before `.array()` it keeps `.array()` available and runs per element.
         */
        codec<Value>(codec: Codec<V, Value>): Column<Value, WithFlags<F, { codec: true }>>;
      }) &
  (F["key"] extends true
    ? unknown
    : {
        /** The table's whole primary key. A composite key goes in `defineTable`'s second callback. */
        primaryKey(options?: ConstraintOptions): Column<
          V,
          WithFlags<
            F,
            {
              notNull: true;
              primaryKey: true;
              key: true;
              fresh: false;
            }
          >
        >;
        /** A unique constraint on this column alone. */
        unique(options?: ConstraintOptions): Column<V, WithFlags<F, { key: true; fresh: false }>>;
      }) &
  (F["references"] extends true
    ? unknown
    : {
        /**
         * A foreign key to another table's primary key or unique column holding the same value. The
         * thunk reads the target late; two tables that point at each other need one thunk to name
         * its type, such as `(): Target<number> => orders.columns.id`. A self reference or a
         * composite key goes in the second callback's `foreignKeys`; `defineDatabase` refuses a
         * self reference here.
         */
        references(
          target: () => Target<V>,
          options?: ForeignKeyOptions,
        ): Column<V, WithFlags<F, { references: true; fresh: false }>>;
      }) &
  (F["generated"] extends true
    ? unknown
    : {
        /** Takes a SQL expression, such as `now()`; a string literal needs its quotes (`"'new'"`). */
        default(expression: string): Column<V, WithFlags<F, { generated: true; fresh: false }>>;
      } & (F["int"] extends true
        ? {
            /** Generates the value from a sequence. */
            identity(
              generated?: Identity,
            ): Column<V, WithFlags<F, { notNull: true; generated: true; fresh: false }>>;
          }
        : unknown));

/** A column of any kind, which is all a table needs to read. */
type AnyColumn = {
  readonly state: ColumnState;
  readonly "~codec": RuntimeCodec | undefined;
  readonly "~types": {
    readonly value: unknown;
    readonly notNull: boolean;
    readonly generated: boolean;
    readonly primaryKey: boolean;
    readonly key: boolean;
  };
};

export function column<V, F extends ColumnFlags>(
  state: ColumnState,
  codec?: RuntimeCodec,
): Column<V, F> {
  const parts = {
    state,
    "~codec": codec,
    array: () => column({ ...state, array: true }, codec),
    notNull: () => column({ ...state, notNull: true }, codec),
    renamedFrom: (oldName: string) => column({ ...state, renamedFrom: oldName }, codec),
    name: (sqlName: string) => column({ ...state, explicitName: sqlName }, codec),
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
  return parts as unknown as Column<V, F>;
}

export type Columns = Record<string, AnyColumn>;
