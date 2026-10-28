import { renamedExpression, type Row, type Table } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";
import { fragment, identifier, join, verbatim, type Fragment } from "../sql/index.ts";
import { encodeValue } from "./codecs.ts";
import {
  and,
  columnIdentifier,
  operandOf,
  refsOf,
  type Predicate,
  type Query,
  type Refs,
  type Selected,
  type Selection,
  type Statement,
} from "./from.ts";

/** A ref holding values of `V`; the brand stays optional, so a NOT NULL column fits a nullable one. */
type ColumnOf<V> = { readonly name: string; readonly "~value"?: V };

/** Marks a query that may return no row, which `client.one` can't take. */
type Maybe = {
  readonly "~maybe": "on conflict may skip the row; run it with client.all";
};

/** A column as a conflict target names it; its type carries the key, so a target checks against the table's keys. */
export type ConflictRef<K extends string> = { readonly "~column": K };

export type ConflictRefs<T extends Table> = {
  readonly [K in keyof T["columns"] & string]: ConflictRef<K>;
};

type TargetNames<G> = G extends readonly ConflictRef<infer K>[] ? K : never;

type JoinNames<G> = G extends readonly [ConflictRef<infer K>]
  ? K
  : G extends readonly [ConflictRef<infer K>, ...infer Rest]
    ? `${K}, ${JoinNames<Rest>}`
    : "";

/** The table's key sets that `N` names exactly, in any order. */
type Matching<U, N extends string> = U extends readonly [infer S, unknown]
  ? [S] extends [N]
    ? [N] extends [S]
      ? U
      : never
    : never
  : never;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

type Refusal<M extends string> = { readonly [Key in M]: never };

/**
 * A full key needs no predicate. Without one, a single partial unique index lends its predicate;
 * two leave Postgres free to pick either, so the target is refused.
 */
export type TargetCheck<T extends Table, G, Found = Matching<T["~keys"], TargetNames<G>>> = [
  Found,
] extends [never]
  ? Refusal<`(${JoinNames<G>}) is not a key of the table`>
  : [Extract<Found, readonly [string, false]>] extends [never]
    ? true extends IsUnion<Found>
      ? Refusal<`(${JoinNames<G>}) has several partial unique indexes and no full key`>
      : unknown
    : unknown;

/** A clause after the conflict action: no second `onConflict`, so the chain can't repeat it. */
export type ConflictStatement<T extends Table, Marker> = Statement & {
  /** Type-only: without `returning`, only `client.run` takes it. */
  readonly "~returns": "count";
  /** The keys of the returned object name the output columns. */
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

export type UpdateStatement<T extends Table, Marker> = ConflictStatement<T, Marker> & {
  /** Skips the update unless it holds, so the row may not come back; repeated calls combine with `and`. */
  where(
    pick: (existing: Refs<T>, excluded: Refs<T>) => Predicate,
  ): UpdateStatement<T, Marker & Maybe>;
};

type GeneratedAlways<T extends Table> = {
  [K in keyof T["columns"]]: T["columns"][K]["~types"]["generated"] extends "always" ? K : never;
}[keyof T["columns"]];

export type ConflictAction<T extends Table, Marker> = {
  doNothing(): ConflictStatement<T, Marker & Maybe>;
  /** Each value is a value of the column's type or the `excluded` column of that type; `undefined` skips it. */
  doUpdate<
    S extends {
      readonly [K in keyof S]: K extends GeneratedAlways<T>
        ? `${K & string} is an identity always column, which Postgres won't update`
        : K extends keyof Row<T>
          ? Row<T>[K] | ColumnOf<Row<T>[K]> | undefined
          : `${K & string} is not a column`;
    },
  >(
    set: (excluded: Refs<T>) => S,
  ): UpdateStatement<T, Marker>;
};

export function conflictRefsOf<T extends Table>(table: T): ConflictRefs<T> {
  const refs = Object.fromEntries(
    Object.keys(table.columns).map((name) => [name, { "~column": name }]),
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one ref per column key.
  return refs as unknown as ConflictRefs<T>;
}

function fullKeys(table: Table): string[][] {
  const single = Object.entries(table.columns).flatMap(([name, column]) =>
    column.state.unique ? [[name]] : [],
  );
  const indexed = table.indexes.flatMap((index) => {
    const columns = plainColumns(index.keys);
    return index.unique && index.where === undefined && columns !== undefined ? [columns] : [];
  });
  return [
    [...table.primaryKey],
    ...single,
    ...table.uniques.map((u) => [...u.columns]),
    ...indexed,
  ];
}

function plainColumns(keys: Table["indexes"][number]["keys"]): string[] | undefined {
  const columns = keys.flatMap((key) => ("column" in key ? [key.column] : []));
  return columns.length === keys.length ? columns : undefined;
}

/** The target, with the predicate of the one partial unique index that backs it when no full key does. */
export function conflictTarget(table: Table, names: readonly string[]): Fragment {
  const wanted = new Set(names);
  const same = (columns: readonly string[]) =>
    columns.length === wanted.size && columns.every((name) => wanted.has(name));
  const columns = join(
    names.map((name) => columnIdentifier(table, name)),
    fragment`, `,
  );
  if (fullKeys(table).some((key) => same(key))) return fragment`(${columns})`;
  const partial = table.indexes.filter((index) => {
    const keys = plainColumns(index.keys);
    return index.unique && index.where !== undefined && keys !== undefined && same(keys);
  });
  const [index] = partial;
  const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  const listed = names.map((name) => JSON.stringify(name)).join(", ");
  if (index === undefined || index.where === undefined) {
    throw new Error(`(${listed}) is not a key of ${qualified}`);
  }
  if (partial.length > 1) {
    throw new Error(`(${listed}) has several partial unique indexes on ${qualified}`);
  }
  const where = renamedExpression(index, (key) => table.columnNames[key] ?? key) ?? index.where;
  return fragment`(${columns}) where ${verbatim(where)}`;
}

/** Builds the statement around a rendered conflict clause, with `returning` and `toSql`. */
export type Finish = (conflict: () => Fragment) => ConflictStatement<Table, unknown>;

function setClause(table: Table, values: Record<string, unknown>): () => Fragment {
  const pairs = Object.entries(values).filter(([, value]) => value !== undefined);
  if (pairs.length === 0) throw new Error("doUpdate needs at least one column to set");
  const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  for (const [key] of pairs) {
    const column = table.columns[key];
    if (column === undefined) throw new Error(`"${key}" is not a column of ${qualified}`);
    if (column.state.identity === "always") {
      throw new Error(
        `"${key}" is an identity always column of ${qualified}, which Postgres won't update`,
      );
    }
  }
  return () =>
    join(
      pairs.map(
        ([key, value]) =>
          fragment`${columnIdentifier(table, key)} = ${operandOf(value) ?? encodeValue(table, key, value)}`,
      ),
      fragment`, `,
    );
}

export function conflictAction(table: Table, target: Fragment, finish: Finish): unknown {
  const self = fragment`${identifier(table.schema)}.${identifier(table.name)}`;
  const update = (set: () => Fragment, filter: Predicate | undefined): unknown => ({
    ...finish(() =>
      filter === undefined
        ? fragment`on conflict ${target} do update set ${set()}`
        : fragment`on conflict ${target} do update set ${set()} where ${filter["~predicate"]()}`,
    ),
    where(pick: (existing: Refs<Table>, excluded: Refs<Table>) => Predicate) {
      const next = pick(refsOf(table, self), refsOf(table, fragment`excluded`));
      return update(set, filter === undefined ? next : and(filter, next));
    },
  });
  return {
    doNothing: () => finish(() => fragment`on conflict ${target} do nothing`),
    doUpdate: (pick: (excluded: Refs<Table>) => Record<string, unknown>) =>
      update(setClause(table, pick(refsOf(table, fragment`excluded`))), undefined),
  };
}
