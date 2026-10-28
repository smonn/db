// Throwaway probe for #658: the decided join shape's types.
import type { Row, Table } from "../definition/index.ts";
import type { Predicate, Query, Selected } from "./from.ts";

/** One FROM entry, type-side: the table and whether a left join nulls its columns. */
export type Joined = readonly [table: Table, nullable: boolean];

/** `~value` is required, unlike `from.ts`, so a mismatch prints no exactOptionalPropertyTypes hint. */
type Selectable<V> = { readonly name: string; readonly "~value": V };

/**
 * A column operand: any column holding the same non-null type, nullable or not. Written as
 * `JoinRef<V>` alone, a nullable column (or any left-joined one) could never be an operand.
 */
export type ColumnOperand<V> = Selectable<V | null>;

type Comparisons<V> = {
  eq(operand: V | ColumnOperand<V>): Predicate;
  ne(operand: V | ColumnOperand<V>): Predicate;
  gt(operand: V | ColumnOperand<V>): Predicate;
  gte(operand: V | ColumnOperand<V>): Predicate;
  lt(operand: V | ColumnOperand<V>): Predicate;
  lte(operand: V | ColumnOperand<V>): Predicate;
};

type NullChecks = { isNull(): Predicate; isNotNull(): Predicate };

export type JoinRef<V> = Selectable<V> &
  (null extends V ? NullChecks : unknown) &
  Comparisons<NonNullable<V>>;

export type TableRefs<T extends Table, N extends boolean = false> = {
  readonly [K in keyof Row<T> & string]: JoinRef<N extends true ? Row<T>[K] | null : Row<T>[K]>;
};

/** One callback parameter per FROM entry, in join order. */
export type RefsOf<J extends readonly Joined[]> = {
  [I in keyof J]: J[I] extends readonly [infer T extends Table, infer N extends boolean]
    ? TableRefs<T, N>
    : never;
};

export type Selection = Record<string, Selectable<unknown>>;
type Ordering = Selectable<unknown>;

type Joins<J extends readonly Joined[]> = {
  innerJoin<T extends Table>(
    table: T,
    on: (...refs: RefsOf<[...J, [T, false]]>) => Predicate,
  ): JoinedBuilder<[...J, [T, false]]>;
  /** `on` sees the joined table's columns as declared; later callbacks see them nullable. */
  leftJoin<T extends Table>(
    table: T,
    on: (...refs: RefsOf<[...J, [T, false]]>) => Predicate,
  ): JoinedBuilder<[...J, [T, true]]>;
};

/** A joined builder is no Query: it needs `select` to name its outputs. */
export type JoinedBuilder<J extends readonly Joined[]> = Joins<J> & {
  where(pick: (...refs: RefsOf<J>) => Predicate): JoinedBuilder<J>;
  orderBy(pick: (...refs: RefsOf<J>) => Ordering | readonly Ordering[]): JoinedBuilder<J>;
  select<S extends Selection>(pick: (...refs: RefsOf<J>) => S): SelectedQuery<J, Selected<S>>;
};

/** After `select`: no join methods and no `pick`. */
export type SelectedQuery<J extends readonly Joined[], R> = Query<R> & {
  where(pick: (...refs: RefsOf<J>) => Predicate): SelectedQuery<J, R>;
  orderBy(pick: (...refs: RefsOf<J>) => Ordering | readonly Ordering[]): SelectedQuery<J, R>;
  select<S extends Selection>(pick: (...refs: RefsOf<J>) => S): SelectedQuery<J, Selected<S>>;
};

export type FromQuery<T extends Table> = Query<Row<T>> &
  Joins<[[T, false]]> & {
    where(pick: (columns: TableRefs<T>) => Predicate): FromQuery<T>;
    orderBy(pick: (columns: TableRefs<T>) => Ordering | readonly Ordering[]): FromQuery<T>;
    select<S extends Selection>(
      pick: (columns: TableRefs<T>) => S,
    ): SelectedQuery<[[T, false]], Selected<S>>;
    /** #656's name-list select, stubbed: one table only. */
    pick<K extends keyof Row<T> & string>(
      ...keys: K[]
    ): SelectedQuery<[[T, false]], { [P in K]: Row<T>[P] }>;
  };
