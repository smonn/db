// Throwaway probe for #658, alternative D: a column operand must share the SQL type class, not
// the TypeScript value type. Postgres resolves `uuid = text` to no operator, yet both read `string`.
import type { Row, Table } from "../definition/index.ts";
import type { Predicate, Query, Selected } from "./from.ts";
import { from, type Joined, type Selection } from "./probe-joins.ts";

/** Each column's class from its Column type; a domain or a hand-written column reads `string`. */
type ClassOf<Col> = Col extends { readonly "~types": { readonly sql: infer S extends string } }
  ? S
  : string;

type Selectable<V> = { readonly name: string; readonly "~value": V };

/** A wide class (a domain) accepts any operand, as Postgres casts a domain to its base type. */
export type ClassOperand<C extends string> = Selectable<unknown> & {
  readonly "~class": string extends C ? string : C;
};

type Comparisons<V, C extends string> = {
  eq(operand: V | ClassOperand<C>): Predicate;
  ne(operand: V | ClassOperand<C>): Predicate;
  gt(operand: V | ClassOperand<C>): Predicate;
  gte(operand: V | ClassOperand<C>): Predicate;
  lt(operand: V | ClassOperand<C>): Predicate;
  lte(operand: V | ClassOperand<C>): Predicate;
};

type NullChecks = { isNull(): Predicate; isNotNull(): Predicate };

/** A domain (class `string`) carries `never`, so it is an operand of any column. */
export type ClassRef<V, C extends string> = Selectable<V> & {
  readonly "~class": string extends C ? never : C;
} & (null extends V ? NullChecks : unknown) &
  Comparisons<NonNullable<V>, C>;

export type ClassRefs<T extends Table, N extends boolean = false> = {
  readonly [K in keyof Row<T> & string]: ClassRef<
    N extends true ? Row<T>[K] | null : Row<T>[K],
    ClassOf<T["columns"][K]>
  >;
};

type RefsOf<J extends readonly Joined[]> = {
  [I in keyof J]: J[I] extends readonly [infer T extends Table, infer N extends boolean]
    ? ClassRefs<T, N>
    : never;
};

export type ClassBuilder<J extends readonly Joined[]> = {
  innerJoin<T extends Table>(
    table: T,
    on: (...refs: RefsOf<[...J, [T, false]]>) => Predicate,
  ): ClassBuilder<[...J, [T, false]]>;
  leftJoin<T extends Table>(
    table: T,
    on: (...refs: RefsOf<[...J, [T, false]]>) => Predicate,
  ): ClassBuilder<[...J, [T, true]]>;
  select<S extends Selection>(pick: (...refs: RefsOf<J>) => S): Query<Selected<S>>;
};

export function fromClass<T extends Table>(table: T): ClassBuilder<[[T, false]]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The decided runtime; only the types differ.
  return from(table) as unknown as ClassBuilder<[[T, false]]>;
}
