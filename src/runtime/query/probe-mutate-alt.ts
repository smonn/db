// PROBE (#657, #672): alternative shapes the decision didn't weigh, over the decided runtime.
import type { Row, Table } from "../definition/index.ts";
import type { Fragment } from "../sql/index.ts";
import type { ColumnRef, Predicate, Query, Refs, Selected, Selection, Statement } from "./from.ts";
import {
  deleteFrom as deleteFromRuntime,
  update,
  deleteHead,
  mutation,
  setHead,
  type Many,
  type MutationStatement,
  type NeedsWhere,
} from "./probe-mutate.ts";

/** Alt A: the rows to change are a required argument; `allRows` is the sentinel for every row. */
export type AllRows = { readonly "~allRows": true };
export const allRows: AllRows = { "~allRows": true };

function predicateOf<T extends Table>(
  where: ((columns: Refs<T>) => Predicate) | AllRows,
): ((columns: Refs<T>) => Predicate) | undefined {
  if (typeof where === "function") return where;
  if (where === allRows) return undefined;
  throw new Error("Pass a where callback or allRows");
}

function statement<T extends Table>(
  table: T,
  head: () => Fragment,
  where: ((columns: Refs<T>) => Predicate) | AllRows,
) {
  const pick = predicateOf(where);
  const base = mutation(table, head, undefined);
  return pick === undefined ? base : base.where(pick);
}

export function deleteWhere<T extends Table, W extends ((columns: Refs<T>) => Predicate) | AllRows>(
  table: T,
  where: W,
): MutationStatement<T, W extends AllRows ? Many : unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
  return statement(table, deleteHead(table), where) as never;
}

export function updateWhere<T extends Table, W extends ((columns: Refs<T>) => Predicate) | AllRows>(
  table: T,
  where: W,
): {
  set(values: {
    [
      K in keyof T["columns"] as T["columns"][K]["~types"]["generated"] extends "always" ? never : K
    ]?: Row<T>[K];
  }): MutationStatement<T, W extends AllRows ? Many : unknown>;
} {
  return {
    set(values) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The marker exists only in types.
      return statement(table, setHead(table, values), where) as never;
    },
  };
}

/** Alt B: an identity-always key stays, typed `never`, so the error can say which key and why. */
export function updateNever<T extends Table>(
  table: T,
): {
  set(values: {
    [K in keyof T["columns"]]?: T["columns"][K]["~types"]["generated"] extends "always"
      ? never
      : Row<T>[K];
  }): NeedsWhere<T>;
} {
  return { set: (values) => decided(table, values) };
}

type SetRow<T extends Table> = {
  [
    K in keyof T["columns"] as T["columns"][K]["~types"]["generated"] extends "always" ? never : K
  ]?: Row<T>[K];
};

/** Alt C: the decided mapped type behind an alias, which #656 found prints the Table instead of keys. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- PROBE: the alias is the point.
export function updateAlias<T extends Table>(table: T): { set(values: SetRow<T>): NeedsWhere<T> } {
  return { set: (values) => decided(table, values) };
}

/** Alt D: no identity mode in the column type; only the runtime refuses an identity-always key. */
export function updateLoose<T extends Table>(
  table: T,
): { set(values: { [K in keyof Row<T>]?: Row<T>[K] }): NeedsWhere<T> } {
  return { set: (values) => decided(table, values) };
}

/** Alt E: the not-yet-runnable builder says why in a property the Statement check reads. */
export type UpdateNeedsWhereOrAllRows<T extends Table> = Omit<NeedsWhere<T>, never> & {
  readonly toSql: { readonly "call where() or allRows() before running this": never };
};

export function deleteFromMessage<T extends Table>(table: T): UpdateNeedsWhereOrAllRows<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PROBE: the runtime toSql throws.
  return deleteFromRuntime(table) as unknown as UpdateNeedsWhereOrAllRows<T>;
}

function decided<T extends Table>(table: T, values: object): NeedsWhere<T> {
  return update(table).set(values);
}

/** Alt B2: an identity-always key becomes a message key, so the excess-key error prints why. */
export function updateExplain<T extends Table>(
  table: T,
): {
  set(values: {
    [
      K in keyof T["columns"] as T["columns"][K]["~types"]["generated"] extends "always"
        ? `${K & string} is generated always, so update can't set it`
        : K
    ]?: K extends keyof Row<T> ? Row<T>[K] : never;
  }): NeedsWhere<T>;
} {
  return { set: (values) => decided(table, values) };
}

type RowRefs<R> = { readonly [K in keyof R & string]: ColumnRef<R[K]> };

/** Alt H: the builder types take the row, not the Table, so an error prints the row's keys. */
type MutationOf<R, Marker = unknown> = Statement & {
  readonly "~returns": "count";
  returning<S extends Selection>(pick: (columns: RowRefs<R>) => S): Query<Selected<S>> & Marker;
};

type FilteredMutationOf<R> = MutationOf<R> & {
  where(pick: (columns: RowRefs<R>) => Predicate): FilteredMutationOf<R>;
};

export type DeleteNeedsWhereOrAllRows<R> = {
  where(pick: (columns: RowRefs<R>) => Predicate): FilteredMutationOf<R>;
  allRows(): MutationOf<R, Many>;
};

export function deleteFromRow<T extends Table>(
  table: T,
): DeleteNeedsWhereOrAllRows<{ [K in keyof T["columns"]]: Row<T>[K] }> {
  return deleteFromRuntime(table);
}
