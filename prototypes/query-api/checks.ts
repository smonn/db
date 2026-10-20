// PROTOTYPE, throwaway. Type tests for both variants. `npm run check` passes
// only if every Expect holds and every @ts-expect-error line fails to compile.

import * as A from "./a-query-values/lib.ts";
import * as B from "./b-bound-client/lib.ts";
import db, { type OrderMetadata } from "./db.ts";
import type { Row } from "./definition.ts";
import type { Driver } from "./query.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const { users, orders } = db.public;
const { sessions } = db.auth;
declare const driver: Driver;

// Variant A: build values, then run them.
const client = A.createClient(driver);

const aAll = await client.all(A.from(users));
const aAdults = await client.all(
  A.from(users)
    .where((u) => u.age.gte(18).and(u.is_admin.eq(false)))
    .select((u) => ({ id: u.id, name: u.display_name })),
);
const aPicked = await client.one(A.from(users).where((u) => u.email.eq("a@b.c")).select("id", "email"));
const aOps = await client.all(
  A.from(orders)
    .where((o, { or }) => or(o.quantity.gt(10), o.shipped_at.isNull()))
    .select((o) => ({ id: o.id, metadata: o.metadata })),
);
const aSession = await client.one(A.from(sessions).select("user_id", "expires_at"));
const aInserted = await client.one(
  A.insert(orders)
    .values({ user_id: "u", total: "9.99", placed_on: "2026-10-20" })
    .returning((o) => ({ id: o.id })),
);
const aCount = await client.run(A.insert(users).values([{ email: "a@b.c" }, { email: "d@e.f", age: 30 }]));

// Variant B: await the builder.
const bound = B.connect(driver);

const bAll = await bound.from(users);
const bAdults = await bound
  .from(users)
  .where((u) => u.age.gte(18).and(u.is_admin.eq(false)))
  .select((u) => ({ id: u.id, name: u.display_name }));
const bPicked = await bound.from(users).where((u) => u.email.eq("a@b.c")).select("id", "email").one();
const bInserted = await bound
  .insert(orders)
  .values({ user_id: "u", total: "9.99", placed_on: "2026-10-20" })
  .returning("id")
  .one();
const bCount = await bound.insert(users).values({ email: "a@b.c" });

export type Checks = [
  Expect<Equal<typeof aAll, Row<typeof users>[]>>,
  Expect<Equal<typeof aAdults, { id: string; name: string | null }[]>>,
  Expect<Equal<typeof aPicked, { id: string; email: string }>>,
  Expect<Equal<typeof aOps, { id: bigint; metadata: OrderMetadata }[]>>,
  // Composite key columns are NOT NULL, so user_id is a string.
  Expect<Equal<typeof aSession, { user_id: string; expires_at: Date }>>,
  Expect<Equal<typeof aInserted, { id: bigint }>>,
  Expect<Equal<typeof aCount, { count: number }>>,

  Expect<Equal<typeof bAll, Row<typeof users>[]>>,
  Expect<Equal<typeof bAdults, typeof aAdults>>,
  Expect<Equal<typeof bPicked, typeof aPicked>>,
  Expect<Equal<typeof bInserted, { id: bigint }>>,
  Expect<Equal<typeof bCount, { count: number }>>,
];

// Never called: these exist only for the type checker.
export function rejected() {
  // @ts-expect-error age is a number
  A.from(users).where((u) => u.age.gt("18"));

  // @ts-expect-error id is a uuid string
  A.from(users).where((u) => u.id.eq(1));

  // @ts-expect-error bigint columns compare to bigints: 1n, not 1
  A.from(orders).where((o) => o.id.eq(1));

  // @ts-expect-error eq(null) is never allowed; use isNull()
  A.from(users).where((u) => u.display_name.eq(null));

  // @ts-expect-error email is NOT NULL, so it has no isNull()
  A.from(users).where((u) => u.email.isNull());

  // @ts-expect-error booleans have no ordering operators
  A.from(users).where((u) => u.is_admin.gt(true));

  // @ts-expect-error like is for text columns only
  A.from(users).where((u) => u.age.like("1%"));

  // @ts-expect-error a JavaScript comparison is a boolean, not a predicate
  A.from(users).where((u) => u.age > 18);

  // @ts-expect-error no such column
  A.from(users).select("nope");

  // @ts-expect-error a selection holds columns, not values
  A.from(users).select(() => ({ one: 1 }));

  // @ts-expect-error email is required on insert
  A.insert(users).values({});

  // @ts-expect-error an identity column cannot be inserted
  A.insert(orders).values({ id: 1n, user_id: "u", total: "1.00", placed_on: "2026-10-20" });

  // @ts-expect-error no such column
  A.insert(users).values({ email: "a@b.c", nickname: "x" });

  // @ts-expect-error an insert without returning yields no rows; use run()
  void client.all(A.insert(users).values({ email: "a@b.c" }));

  // @ts-expect-error the select argument cannot be empty
  bound.from(users).select();

  return async () => {
    // @ts-expect-error an insert without returning resolves to { count }
    const rows: Row<typeof users>[] = await bound.insert(users).values({ email: "a@b.c" });
    return rows;
  };
}
