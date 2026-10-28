import type { Columns } from "./column.ts";
import type { CheckedForeignKeys, ForeignKeyEntries } from "./foreign-key-entries.ts";
import type { IndexEntry } from "./index-entries.ts";
import type { ColumnRefs, OwnRef, Ref } from "./refs.ts";

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
  /** The table's SQL name in place of its key, for a name casing can't produce. */
  readonly name?: string;
  readonly unique?: readonly UniqueEntry<C>[];
  readonly foreignKeys?: ForeignKeyEntries<C>;
  readonly indexes?: readonly IndexEntry<OwnRef<C>>[];
} & ([KeyedColumns<C>] extends [never]
  ? { readonly primaryKey?: KeyEntry<C> }
  : { readonly primaryKey?: never });

/** The arguments after the columns; a misuse of the primary key leaves no argument list that fits. */
export type ExtrasArgs<C extends Columns, Args = never> =
  IsUnion<KeyedColumns<C>> extends true
    ? [
        extras: (t: ColumnRefs<C>) => {
          readonly primaryKey?: never;
          readonly "several columns call primaryKey(); declare a composite key in the second callback": never;
        },
      ]
    : [extras?: (t: ColumnRefs<C>) => TableExtras<C> & CheckedForeignKeys<C, Args>];

type ListedRefs<Entry> = Entry extends { readonly columns: infer Listed } ? Listed : Entry;

export type KeyOf<C extends Columns, Args extends unknown[]> = Args extends [
  (t: never) => { readonly primaryKey: infer Entry },
]
  ? ListedRefs<Entry> extends readonly Ref<infer K, C>[]
    ? K
    : never
  : KeyedColumns<C>;

/**
 * One column set a conflict target may name: the column keys as a union, since Postgres infers the
 * arbiter regardless of order, and whether only a partial unique index backs it.
 */
export type KeySet = readonly [columns: string, partial: boolean];

type ReturnOf<Args extends unknown[]> = Args extends [(t: never) => infer R] ? R : unknown;

type ColumnKeySets<C extends Columns> = {
  [Name in keyof C & string]: C[Name]["~types"]["key"] extends true
    ? readonly [Name, false]
    : never;
}[keyof C & string];

type PrimaryKeySet<K extends string> = [K] extends [never] ? never : readonly [K, false];

type UniqueSets<C extends Columns, R> = R extends { readonly unique: readonly (infer Entry)[] }
  ? Entry extends { readonly columns: readonly Ref<infer N, C>[] }
    ? readonly [N, false]
    : never
  : never;

type KeyNameOf<C extends Columns, Key> =
  Key extends Ref<infer N, C> ? N : Key extends { readonly key: Ref<infer N, C> } ? N : never;

/** An index key that is neither a ref nor a wrapped ref is an expression, which no column list infers. */
type HasExpression<C extends Columns, Keys extends readonly unknown[]> = [
  Exclude<Keys[number], OwnRef<C> | { readonly key: OwnRef<C> }>,
] extends [never]
  ? false
  : true;

type IndexSets<C extends Columns, R> = R extends { readonly indexes: readonly (infer Entry)[] }
  ? Entry extends { readonly unique: true; readonly columns: infer Keys extends readonly unknown[] }
    ? HasExpression<C, Keys> extends true
      ? never
      : readonly [
          KeyNameOf<C, Keys[number]>,
          Entry extends { readonly where: object } ? true : false,
        ]
    : never
  : never;

/** Every column set the table declares unique, as `KeySet`s. */
export type KeySetsOf<C extends Columns, Args extends unknown[]> =
  | PrimaryKeySet<KeyOf<C, Args>>
  | ColumnKeySets<C>
  | UniqueSets<C, ReturnOf<Args>>
  | IndexSets<C, ReturnOf<Args>>;
