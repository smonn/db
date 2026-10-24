/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway. Variant B: every foreign key goes in defineTable's second callback.
import {
  type ColumnState,
  type Columns,
  type ForeignKeyDecl,
  of,
  ownColumn,
  primaryKeyOf,
  refsOf,
  resolve,
  type RuntimeRef,
  type TableDefinition,
  type TableForeignKeyOptions,
  type Target,
  type Types,
} from "../core.ts";

export type Column<V, N extends boolean = false, Key extends boolean = false> = {
  readonly state: ColumnState;
  readonly "~types": Types<V, N, Key>;
  notNull(): Column<V, true, Key>;
  primaryKey(): Column<V, true, true>;
  unique(): Column<V, N, true>;
};

export type Factories = {
  readonly integer: () => Column<number>;
  readonly bigint: () => Column<bigint>;
  readonly uuid: () => Column<string>;
  readonly text: () => Column<string>;
};

export const factories = {
  integer: () => of("integer"),
  bigint: () => of("bigint"),
  uuid: () => of("uuid"),
  text: () => of("text"),
} as Factories;

/** Invariant in `C`, as in `src/`: a ref names only its own table's columns. */
export type Ref<K extends string, C extends Columns> = {
  readonly "~ref": K;
  readonly "~table": (columns: C) => C;
};

export type Refs<C extends Columns> = { readonly [K in keyof C & string]: Ref<K, C> };

type OwnRef<C extends Columns> = Ref<keyof C & string, C>;

type ValueAt<C extends Columns, R> = R extends Ref<infer K, C> ? C[K]["~types"]["value"] : never;

/** One of this table's key columns holding a `V`: the target of a self reference. */
type OwnTarget<C extends Columns, V> = {
  [K in keyof C & string]: C[K]["~types"] extends Types<V, boolean, true> ? Ref<K, C> : never;
}[keyof C & string];

/**
 * `references` takes the table's own refs for a self reference, or a thunk of another table's
 * columns, read lazily so tables in an import cycle can point at each other.
 */
export type ForeignKeyEntry<C extends Columns> = TableForeignKeyOptions & {
  readonly columns: readonly [OwnRef<C>, ...OwnRef<C>[]];
  readonly references:
    | readonly [OwnRef<C>, ...OwnRef<C>[]]
    | (() => readonly [AnyTarget<unknown>, ...AnyTarget<unknown>[]]);
};

/** Any column holding a `V`; `defineDatabase` checks that a composite target is a key. */
type AnyTarget<V> = { readonly state: ColumnState; readonly "~types": Types<V, boolean, boolean> };

/**
 * Pairs each listed column with a target column of the same type. A single target must be a key
 * column; a composite key's columns aren't keys one by one, so `defineDatabase` checks those.
 */
export type Paired<C extends Columns, Cols> = Cols extends readonly [infer Only]
  ? readonly [OwnTarget<C, ValueAt<C, Only>>] | (() => readonly [Target<ValueAt<C, Only>>])
  : Cols extends readonly unknown[]
    ?
        | { readonly [I in keyof Cols]: OwnRef<C> }
        | (() => { readonly [I in keyof Cols]: AnyTarget<ValueAt<C, Cols[I]>> })
    : never;

export type Extras<C extends Columns> = {
  readonly primaryKey?: readonly [OwnRef<C>, OwnRef<C>, ...OwnRef<C>[]];
  readonly foreignKeys?: readonly ForeignKeyEntry<C>[];
};

/** Checks every entry after inference; an unpaired target fails here. */
export type Checked<C extends Columns, X> = X extends {
  readonly foreignKeys: infer F extends readonly unknown[];
}
  ? {
      readonly foreignKeys: {
        readonly [I in keyof F]: F[I] extends { readonly columns: infer Cols }
          ? { readonly references: Paired<C, Cols> }
          : never;
      };
    }
  : unknown;

export function tableParts(
  columns: Columns,
  own: Record<string, RuntimeRef>,
  declared: Extras<Columns> | undefined,
) {
  const foreignKeys: ForeignKeyDecl[] = (declared?.foreignKeys ?? []).map((entry) => {
    const { columns: listed, references, ...options } = entry;
    return {
      columns: listed.map((ref) => ownColumn(own, ref)),
      target:
        typeof references === "function"
          ? { other: references }
          : { self: references.map((ref) => ownColumn(own, ref)) },
      options,
    };
  });
  const primaryKey = primaryKeyOf(
    columns,
    (declared?.primaryKey ?? []).map((ref) => ownColumn(own, ref)),
  );
  return { primaryKey, foreignKeys };
}

export function defineTable<C extends Columns, const X extends Extras<C>>(
  define: (c: Factories) => C,
  extras?: (t: Refs<C>) => X & Checked<C, X>,
): TableDefinition<C> {
  const columns = define(factories);
  const own: Record<string, RuntimeRef> = refsOf(columns);
  const declared = extras?.(own as unknown as Refs<C>) as Extras<Columns> | undefined;
  const parts = tableParts(columns, own, declared);
  return { columns, primaryKey: parts.primaryKey, foreignKeys: parts.foreignKeys };
}

export function defineDatabase<S extends Record<string, Record<string, TableDefinition>>>(
  schemas: S,
) {
  return { schemas, foreignKeys: resolve(schemas) };
}
