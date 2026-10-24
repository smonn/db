/* oxlint-disable -- throwaway prototype on a branch that is never merged */
// PROTOTYPE, throwaway: the mistakes each variant must reject at compile time.
import * as A from "./a-column/lib.ts";
import { orders as aOrders } from "./a-column/tables/orders.ts";
import * as B from "./b-table/lib.ts";
import { orders as bOrders } from "./b-table/tables/orders.ts";
import * as C from "./c-both/lib.ts";
import type { Target } from "./core.ts";
import * as D from "./d-database/lib.ts";
import * as dTables from "./d-database/tables.ts";

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
export type Expect<T extends true> = T;

// A foreign key changes no column type: nullability stays the column's own.
export type _A = Expect<Equal<(typeof aOrders.columns.user_id)["~types"]["value"], number>>;
export type _B = Expect<Equal<(typeof aOrders.columns.user_id)["~types"]["notNull"], true>>;

// 1. A uuid column can't point at an integer key.
// @ts-expect-error -- Column<number, true, true> is not assignable to Target<string>
A.defineTable((c) => ({ x: c.uuid().references(() => aOrders.columns.id) }));
B.defineTable(
  (c) => ({ x: c.uuid() }),
  // @ts-expect-error -- () => [Column<number, ...>] is not assignable to () => readonly [Target<string>]
  (t) => ({ foreignKeys: [{ columns: [t.x], references: () => [bOrders.columns.id] }] }),
);
// @ts-expect-error -- as in A
C.defineTable((c) => ({ x: c.uuid().references(() => aOrders.columns.id) }));
D.defineDatabase(
  { public: { orders: dTables.orders, t: D.defineTable((c) => ({ x: c.uuid() })) } },
  // @ts-expect-error -- readonly [DbRef<number, true>] is not assignable to readonly [DbRef<string, true>]
  (db) => ({
    foreignKeys: [{ columns: [db.public.t.x], references: [db.public.orders.id] }],
  }),
);

// 2. The target must be a primary key or unique column.
// @ts-expect-error -- 'false' is not assignable to 'true' (the key flag)
A.defineTable((c) => ({ x: c.integer().references(() => aOrders.columns.user_id) }));
B.defineTable(
  (c) => ({ x: c.integer() }),
  // @ts-expect-error -- () => [Column<number, true, false>] is not assignable to () => readonly [Target<number>]
  (t) => ({ foreignKeys: [{ columns: [t.x], references: () => [bOrders.columns.user_id] }] }),
);
D.defineDatabase(
  { public: { orders: dTables.orders, t: D.defineTable((c) => ({ x: c.integer() })) } },
  // @ts-expect-error -- readonly [DbRef<number, false>] is not assignable to readonly [DbRef<number, true>]
  (db) => ({
    foreignKeys: [{ columns: [db.public.t.x], references: [db.public.orders.user_id] }],
  }),
);

// 3. Two columns can't point at one.
B.defineTable(
  (c) => ({ x: c.integer(), y: c.integer() }),
  // @ts-expect-error -- [Column<number, true, true>] is not assignable to readonly [AnyTarget<number>, AnyTarget<number>]
  (t) => ({ foreignKeys: [{ columns: [t.x, t.y], references: () => [bOrders.columns.id] }] }),
);

// 4. A self reference must name a key of its own table.
B.defineTable(
  (c) => ({ id: c.integer().primaryKey(), parent_id: c.integer(), note: c.text() }),
  // @ts-expect-error -- '"note"' is not assignable to '"id"'
  (t) => ({ foreignKeys: [{ columns: [t.parent_id], references: [t.note] }] }),
);

// 5. A self reference on the column can't infer its own type without an annotation.
// @ts-expect-error -- TS7022: 'categories' implicitly has type 'any'
const categories = A.defineTable((c) => ({
  id: c.integer().primaryKey(),
  // @ts-expect-error -- TS7024: function implicitly has return type 'any'
  parent_id: c.integer().references(() => categories.columns.id),
}));
export const annotated = A.defineTable((c) => ({
  id: c.integer().primaryKey(),
  parent_id: c.integer().references((): Target<number> => annotated.columns.id),
}));
