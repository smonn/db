import { expressionText, type Table } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";
import { fragment, join, verbatim, type Fragment } from "../sql/index.ts";
import { columnIdentifier } from "./refs.ts";

/** A column as a conflict target names it; its key sits in its type, so the target checks against the table's keys. */
export type ConflictRef<K extends string> = { readonly "~column": K };

/** Typed over the row `T`, not its Table, so an error prints the row's keys. */
export type ConflictRefs<T> = { readonly [K in keyof T & string]: ConflictRef<K> };

type TargetNames<G> = G extends readonly ConflictRef<infer K>[] ? K : never;

type JoinNames<G> = G extends readonly [ConflictRef<infer K>]
  ? K
  : G extends readonly [ConflictRef<infer K>, ...infer Rest]
    ? `${K}, ${JoinNames<Rest>}`
    : "";

/** The key sets of `U` whose columns are exactly `N`, in any order. */
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
 * Refuses a target `G` that names no key set of `U`. A full key needs no predicate; without one,
 * a single partial unique index lends its predicate, and two would leave Postgres free to pick
 * either, so the target is refused.
 */
export type TargetCheck<U, G, Found = Matching<U, TargetNames<G>>> = [Found] extends [never]
  ? Refusal<`(${JoinNames<G>}) is not a key of the table`>
  : [Extract<Found, readonly [string, false]>] extends [never]
    ? true extends IsUnion<Found>
      ? Refusal<`(${JoinNames<G>}) has several partial unique indexes and no full key`>
      : unknown
    : unknown;

type Index = Table["indexes"][number];

/** Whether `columns` are exactly the `wanted` ones, in any order. */
function same(columns: readonly string[], wanted: ReadonlySet<string>): boolean {
  return columns.length === wanted.size && columns.every((name) => wanted.has(name));
}

/** Whether a unique `index` keys exactly the `wanted` columns; an expression key names none. */
function indexes(index: Index, wanted: ReadonlySet<string>): boolean {
  // Stryker disable next-line ArrayDeclaration: 1 survivors: a stand-in for an expression key matches no wanted column either.
  const columns = index.keys.flatMap((key) => ("column" in key ? [key.column] : []));
  return index.unique && index.keys.length === columns.length && same(columns, wanted);
}

/** Whether a key no index predicate limits has exactly the `wanted` columns. */
function isFullKey(table: Table, wanted: ReadonlySet<string>): boolean {
  return (
    same(table.primaryKey, wanted) ||
    Object.entries(table.columns).some(
      ([name, column]) => column.state.unique && same([name], wanted),
    ) ||
    table.uniques.some((unique) => same(unique.columns, wanted)) ||
    table.indexes.some((index) => index.where === undefined && indexes(index, wanted))
  );
}

/**
 * The target, with the predicate of the one partial unique index behind it when no full key is,
 * so Postgres infers that index. Throws when neither matches or two partial indexes do.
 */
export function conflictTarget(table: Table, names: readonly string[]): Fragment {
  const wanted = new Set(names);
  const columns = fragment`(${join(
    names.map((name) => columnIdentifier(table, name)),
    fragment`, `,
  )})`;
  if (isFullKey(table, wanted)) return columns;
  const partial = table.indexes.flatMap((index) => {
    const { where } = index;
    // Stryker disable next-line ConditionalExpression: 1 survivors: a full index on these columns returned above, so only the type needs it.
    return where !== undefined && indexes(index, wanted) ? [{ index, where }] : [];
  });
  const listed = `(${[...wanted].map((name) => quoteIdentifier(name)).join(", ")})`;
  const qualified = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  const [found, ...others] = partial;
  if (found === undefined) throw new Error(`${listed} is not a key of ${qualified}`);
  if (others.length > 0) {
    throw new Error(`${listed} has several partial unique indexes and no full key on ${qualified}`);
  }
  return fragment`${columns} where ${verbatim(expressionText(table, found.index, found.where))}`;
}

/** The column keys a target callback returned, refusing anything but this table's conflict refs. */
export function targetNames<T>(
  table: Table,
  pick: (columns: ConflictRefs<T>) => unknown,
): string[] {
  const refs = new Map<unknown, string>(
    // Stryker disable next-line ObjectLiteral: 1 survivors: the key matters to the type; the map finds a ref by identity.
    Object.keys(table.columns).map((key) => [{ "~column": key }, key]),
  );
  const columns = Object.fromEntries([...refs].map(([ref, key]) => [key, ref]));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries loses the keys.
  const picked: unknown = pick(columns as ConflictRefs<T>);
  const names: unknown[] = Array.isArray(picked) ? picked.map((item) => refs.get(item)) : [];
  const keys = names.filter((name) => typeof name === "string");
  if (keys.length === 0 || keys.length < names.length) {
    throw new Error("onConflict callback must return a list of the table's columns");
  }
  return keys;
}
