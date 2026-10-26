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
