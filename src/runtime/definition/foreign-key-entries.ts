import type { Columns } from "./column.ts";
import type { KeyPart, TableForeignKeyOptions, Target } from "./references.ts";
import type { OwnRef, Ref } from "./refs.ts";

/**
 * A foreign key from one or more of this table's columns. `references` is this table's own
 * references for a self reference, or a thunk of another table's columns, so tables in an import
 * cycle load in either order.
 */
export type ForeignKeyEntry<C extends Columns> = TableForeignKeyOptions & {
  readonly columns: readonly [OwnRef<C>, ...OwnRef<C>[]];
  readonly references:
    | readonly [OwnRef<C>, ...OwnRef<C>[]]
    | (() => readonly [KeyPart, ...KeyPart[]]);
};

type ValueAt<C extends Columns, R> = R extends Ref<infer K, C> ? C[K]["~types"]["value"] : never;

/** One of this table's columns holding a `V`, and a key when `Key` is true. */
type OwnTarget<C extends Columns, V, Key extends boolean> = {
  [K in keyof C & string]: C[K]["~types"] extends { readonly value: V; readonly key: Key }
    ? Ref<K, C>
    : never;
}[keyof C & string];

/**
 * What `references` must be for the listed columns: one target of the same value that is a key, or
 * for several columns one of the same value each, which `defineDatabase` checks form a primary key.
 */
type PairedReferences<C extends Columns, Listed> = Listed extends readonly [infer Only]
  ? readonly [OwnTarget<C, ValueAt<C, Only>, true>] | (() => readonly [Target<ValueAt<C, Only>>])
  : Listed extends readonly unknown[]
    ?
        | { readonly [I in keyof Listed]: OwnTarget<C, ValueAt<C, Listed[I]>, boolean> }
        | (() => { readonly [I in keyof Listed]: KeyPart<ValueAt<C, Listed[I]>> })
    : never;

/** Checks each entry's `references` against its `columns`, once inference has them. */
export type CheckedForeignKeys<C extends Columns, Args> = Args extends [
  (t: never) => { readonly foreignKeys: infer Entries extends readonly unknown[] },
]
  ? {
      readonly foreignKeys: {
        readonly [I in keyof Entries]: Entries[I] extends { readonly columns: infer Listed }
          ? { readonly references: PairedReferences<C, Listed> }
          : never;
      };
    }
  : unknown;
