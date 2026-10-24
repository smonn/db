/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway. Variant D: foreign keys go in a second callback of `defineDatabase`, where
// every table already has a name and a value, so no thunk and no import cycle is needed.
import {
  type AnyColumn,
  type ForeignKeyDecl,
  resolve,
  type TableDefinition,
  type TableForeignKeyOptions,
} from "../core.ts";

export { defineTable } from "../b-table/lib.ts";

type Schemas = Record<string, Record<string, TableDefinition>>;

/** A column of the Database, named by schema, table, and column. */
export type DbRef<V = unknown, Key extends boolean = boolean> = {
  readonly "~place": readonly [schema: string, table: string, column: string];
  readonly "~types": { readonly value: V; readonly key: Key };
};

export type DbRefs<S extends Schemas> = {
  readonly [Sc in keyof S & string]: {
    readonly [T in keyof S[Sc] & string]: {
      readonly [K in keyof S[Sc][T]["columns"] & string]: DbRef<
        S[Sc][T]["columns"][K]["~types"]["value"],
        S[Sc][T]["columns"][K]["~types"]["key"]
      >;
    };
  };
};

type Entry = TableForeignKeyOptions & {
  readonly columns: readonly [DbRef, ...DbRef[]];
  readonly references: readonly [DbRef, ...DbRef[]];
};

type ValueAt<R> = R extends DbRef<infer V> ? V : never;

type Paired<Cols> = Cols extends readonly [infer Only]
  ? readonly [DbRef<ValueAt<Only>, true>]
  : { readonly [I in keyof Cols]: DbRef<ValueAt<Cols[I]>> };

type Checked<X> = X extends { readonly foreignKeys: infer F extends readonly unknown[] }
  ? {
      readonly foreignKeys: {
        readonly [I in keyof F]: F[I] extends { readonly columns: infer Cols }
          ? { readonly references: Paired<Cols> }
          : never;
      };
    }
  : unknown;

export function defineDatabase<
  S extends Schemas,
  const X extends { readonly foreignKeys?: readonly Entry[] },
>(schemas: S, links?: (db: DbRefs<S>) => X & Checked<X>) {
  const refs = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([table, { columns }]) => [
          table,
          Object.fromEntries(
            Object.keys(columns).map((column) => [column, { "~place": [schema, table, column] }]),
          ),
        ]),
      ),
    ]),
  );
  const declared = links?.(refs as unknown as DbRefs<S>) as
    | { foreignKeys?: readonly Entry[] }
    | undefined;
  const extra = new Map<TableDefinition, ForeignKeyDecl[]>();
  for (const { columns, references, ...options } of declared?.foreignKeys ?? []) {
    const [schema = "", table = ""] = columns[0]["~place"];
    const owner = schemas[schema]?.[table];
    if (
      owner === undefined ||
      columns.some((c) => c["~place"][0] !== schema || c["~place"][1] !== table)
    ) {
      throw new Error("a foreign key's columns must come from one table");
    }
    const decl: ForeignKeyDecl = {
      columns: columns.map((c) => c["~place"][2]),
      target: {
        other: () =>
          references.map((r) => {
            const [s, t, c] = r["~place"];
            return schemas[s]?.[t]?.columns[c] as AnyColumn;
          }),
      },
      options,
    };
    extra.set(owner, [...(extra.get(owner) ?? []), decl]);
  }
  const withLinks = Object.fromEntries(
    Object.entries(schemas).map(([schema, tables]) => [
      schema,
      Object.fromEntries(
        Object.entries(tables).map(([name, table]) => [
          name,
          { ...table, foreignKeys: [...table.foreignKeys, ...(extra.get(table) ?? [])] },
        ]),
      ),
    ]),
  );
  return { schemas, foreignKeys: resolve(withLinks) };
}
