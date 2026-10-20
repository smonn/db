// PROTOTYPE, throwaway. Type tests: `npm run check` passes only if every
// variant infers the expected rows and rejects the bad Definitions below.

import * as A from "./a-flat-tables/db.ts";
import * as a from "./a-flat-tables/definition.ts";
import * as B from "./b-database-object/db.ts";
import b from "./b-database-object/definition.ts";
import * as C from "./c-column-callback/db.ts";
import * as c from "./c-column-callback/definition.ts";
import type * as E from "./expected.ts";
import type { Equal, Expect } from "./expected.ts";

export type Checks = [
  Expect<Equal<A.Row<typeof a.users>, E.User>>,
  Expect<Equal<A.NewRow<typeof a.users>, E.NewUser>>,
  Expect<Equal<A.Row<typeof a.orders>, E.Order>>,
  Expect<Equal<A.NewRow<typeof a.orders>, E.NewOrder>>,
  Expect<Equal<A.Row<typeof a.sessions>, E.Session>>,
  Expect<Equal<A.NewRow<typeof a.sessions>, E.NewSession>>,

  Expect<Equal<B.Row<typeof b.public.users>, E.User>>,
  Expect<Equal<B.NewRow<typeof b.public.users>, E.NewUser>>,
  Expect<Equal<B.Row<typeof b.public.orders>, E.Order>>,
  Expect<Equal<B.NewRow<typeof b.public.orders>, E.NewOrder>>,
  Expect<Equal<B.Row<typeof b.auth.sessions>, E.Session>>,
  Expect<Equal<B.NewRow<typeof b.auth.sessions>, E.NewSession>>,

  Expect<Equal<C.Row<typeof c.users>, E.User>>,
  Expect<Equal<C.NewRow<typeof c.users>, E.NewUser>>,
  Expect<Equal<C.Row<typeof c.orders>, E.Order>>,
  Expect<Equal<C.NewRow<typeof c.orders>, E.NewOrder>>,
  Expect<Equal<C.Row<typeof c.sessions>, E.Session>>,
  Expect<Equal<C.NewRow<typeof c.sessions>, E.NewSession>>,
];

// Never called: these exist only for the type checker.
export function rejected() {
  // @ts-expect-error a nullable column cannot be the primary key
  A.table("bad", { id: A.text().nullable().primaryKey() });

  // @ts-expect-error identity needs an integer type
  A.table("bad", { id: A.text().generatedAlwaysAsIdentity() });

  // @ts-expect-error a composite primary key must name existing columns
  A.table("bad", { id: A.text() }, { primaryKey: ["nope"] });

  // @ts-expect-error the default must match the column type
  A.table("bad", { n: A.integer().default("one") });

  // @ts-expect-error email is required on insert
  const missingEmail: A.NewRow<typeof a.users> = {};

  // @ts-expect-error an identity column cannot be inserted
  const withId: A.NewRow<typeof a.orders> = { id: 1n, user_id: "u", total: "1.00", placed_on: "2026-10-20" };

  // @ts-expect-error a composite primary key must name existing columns
  B.table({ id: B.text() }, { primaryKey: ["nope"] });

  // @ts-expect-error a composite primary key must name existing columns
  C.table("bad", (c) => ({ id: c.text() }), { primaryKey: ["nope"] });

  return [missingEmail, withId];
}
