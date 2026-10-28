// PROTOTYPE for #656: throwaway, lives only on prototype/query-type-errors.
import {
  defineDatabase,
  defineTable,
  type Row,
  type Table,
} from "../../src/runtime/definition/index.ts";
import type { Query, Refs, Selected, Selection, Statement } from "../../src/runtime/query/from.ts";
import type { NewRow } from "../../src/runtime/query/insert.ts";

export type { NewRow, Query, Refs, Row, Selected, Selection, Statement, Table };

export const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text(), name: c.text() })),
    wide: defineTable((c) => ({
      id: c.text().notNull(),
      c01: c.text(),
      c02: c.text(),
      c03: c.text(),
      c04: c.text(),
      c05: c.text(),
      c06: c.text(),
      c07: c.text(),
      c08: c.text(),
      c09: c.text(),
      c10: c.text(),
      c11: c.text(),
      c12: c.text(),
      c13: c.text(),
      c14: c.text(),
      c15: c.text(),
    })),
  },
});

export type Users = typeof db.public.users;
export type Key<T extends Table> = keyof Row<T> & string;

export type Many = { readonly "~many": true };

export type InsertStatement<T extends Table, Marker = unknown> = Statement & {
  readonly "~returns": "count";
  returning<S extends Selection>(pick: (columns: Refs<T>) => S): Query<Selected<S>> & Marker;
};

/** A name list selects each column under its own key. */
export type Named<T extends Table, K extends Key<T>> = { -readonly [P in K]: Row<T>[P] };

/** Flattened so an error prints the keys instead of `NewRow<Table<...>>`. */
export type FlatRow<T extends Table> = { [K in keyof NewRow<T>]: NewRow<T>[K] } & {};

/** `client.one`'s parameter, so a check can ask whether a query fits it. */
export type OneArg<R> = Query<R> & { readonly "~many"?: never };

export type Equal<X, Y> =
  (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false;
export type Expect<V extends true> = V;
