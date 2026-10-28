// PROTOTYPE for #656: each variant differs only in the signature under test.
import type {
  FlatRow,
  InsertStatement,
  Key,
  Many,
  Named,
  NewRow,
  Query,
  Refs,
  Row,
  Selected,
  Selection,
  Table,
} from "./core.ts";

type Pick<T extends Table, S> = (columns: Refs<T>) => S;

// Select: S0 is today's callback-only `select`.
export type S0<T extends Table> = {
  select<S extends Selection>(pick: Pick<T, S>): Query<Selected<S>>;
};

// S1: overloaded, names first, callback last (ADR-0004's rejected shape).
export type S1<T extends Table> = {
  select<K extends Key<T>>(...names: K[]): Query<Named<T, K>>;
  select<S extends Selection>(pick: Pick<T, S>): Query<Selected<S>>;
};

// S2: overloaded, callback first, names last.
export type S2<T extends Table> = {
  select<S extends Selection>(pick: Pick<T, S>): Query<Selected<S>>;
  select<K extends Key<T>>(...names: K[]): Query<Named<T, K>>;
};

// S3: one signature, generic over both forms; the return type picks the form.
export type S3<T extends Table> = {
  select<K extends Key<T> = never, S extends Selection = never>(
    ...args: [Pick<T, S>] | K[]
  ): Query<[K] extends [never] ? Selected<S> : Named<T, K>>;
};

// S4: a second method for the name list, so neither form overloads.
export type S4<T extends Table> = S0<T> & {
  pick<K extends Key<T>>(...names: K[]): Query<Named<T, K>>;
};

// S5: S1 with the key type written inline instead of through the `Key` alias.
export type S5<T extends Table> = {
  select<K extends keyof Row<T> & string>(...names: K[]): Query<Named<T, K>>;
  select<S extends Selection>(pick: Pick<T, S>): Query<Selected<S>>;
};

// S6: S5 with the overloads swapped, names last.
export type S6<T extends Table> = {
  select<S extends Selection>(pick: Pick<T, S>): Query<Selected<S>>;
  select<K extends keyof Row<T> & string>(...names: K[]): Query<Named<T, K>>;
};

// Insert: I0 is today's overloads, array last.
export type I0<T extends Table> = {
  values(row: NewRow<T>): InsertStatement<T>;
  values(rows: readonly NewRow<T>[]): InsertStatement<T, Many>;
};

// I1: the same overloads, one row last.
export type I1<T extends Table> = {
  values(rows: readonly NewRow<T>[]): InsertStatement<T, Many>;
  values(row: NewRow<T>): InsertStatement<T>;
};

// I2: one generic signature; the return type reads the marker off the argument.
export type I2<T extends Table> = {
  values<const V extends NewRow<T> | readonly NewRow<T>[]>(
    rows: V,
  ): InsertStatement<T, V extends readonly unknown[] ? Many : unknown>;
};

// I3: I2 plus a guard that maps each key the table lacks to `never`, since a generic skips excess-key checks.
export type I3<T extends Table> = {
  values<const V extends NewRow<T> | readonly NewRow<T>[]>(
    rows: V & (NewRow<T> | readonly NewRow<T>[]) & NoExtra<V, T>,
  ): InsertStatement<T, V extends readonly unknown[] ? Many : unknown>;
};

type NoExtra<V, T extends Table> = V extends readonly (infer E)[]
  ? readonly { [P in keyof E]: P extends keyof NewRow<T> ? E[P] : never }[]
  : { [P in keyof V]: P extends keyof NewRow<T> ? V[P] : never };

// I4: two methods, so neither overloads.
export type I4<T extends Table> = {
  values(row: NewRow<T>): InsertStatement<T>;
  valuesMany(rows: readonly NewRow<T>[]): InsertStatement<T, Many>;
};

// I5: I4 with the row type flattened, so errors print keys rather than `NewRow<Table<...>>`.
export type I5<T extends Table> = {
  values(row: FlatRow<T>): InsertStatement<T>;
  valuesMany(rows: readonly FlatRow<T>[]): InsertStatement<T, Many>;
};

// I7: I1's overload order with the row type written inline, so no alias name is left to print.
export type I7<T extends Table> = {
  values(rows: readonly { [K in keyof NewRow<T>]: NewRow<T>[K] }[]): InsertStatement<T, Many>;
  values(row: { [K in keyof NewRow<T>]: NewRow<T>[K] }): InsertStatement<T>;
};

// I8: I4's two methods with the row type written inline.
export type I8<T extends Table> = {
  values(row: { [K in keyof NewRow<T>]: NewRow<T>[K] }): InsertStatement<T>;
  valuesMany(rows: readonly { [K in keyof NewRow<T>]: NewRow<T>[K] }[]): InsertStatement<T, Many>;
};

// I9: rows as arguments, overloaded by count, so only one overload fits a call's arity.
export type I9<T extends Table> = {
  values(row: { [K in keyof NewRow<T>]: NewRow<T>[K] }): InsertStatement<T>;
  values(
    row: { [K in keyof NewRow<T>]: NewRow<T>[K] },
    ...more: [
      { [K in keyof NewRow<T>]: NewRow<T>[K] },
      ...{ [K in keyof NewRow<T>]: NewRow<T>[K] }[],
    ]
  ): InsertStatement<T, Many>;
};

// I6: I1's overload order with the flattened row.
export type I6<T extends Table> = {
  values(rows: readonly FlatRow<T>[]): InsertStatement<T, Many>;
  values(row: FlatRow<T>): InsertStatement<T>;
};
