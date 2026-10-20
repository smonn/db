// PROTOTYPE, throwaway. Type tests for variant D.

import type * as E from "../expected.ts";
import type { Equal, Expect } from "../expected.ts";
import db from "./db.ts";
import { defineTable, type NewRow, type Row } from "./lib.ts";
import type { orders } from "./tables/orders.ts";
import type { sessions } from "./tables/sessions.ts";
import type { User, users } from "./tables/users.ts";

export type Checks = [
  Expect<Equal<Row<typeof db.public.users>, E.User>>,
  Expect<Equal<NewRow<typeof db.public.users>, E.NewUser>>,
  Expect<Equal<Row<typeof db.public.orders>, E.Order>>,
  Expect<Equal<NewRow<typeof db.public.orders>, E.NewOrder>>,
  Expect<Equal<Row<typeof db.auth.sessions>, E.Session>>,
  Expect<Equal<NewRow<typeof db.auth.sessions>, E.NewSession>>,

  // The standalone definitions infer the same rows as the rolled-up tables.
  Expect<Equal<User, E.User>>,
  Expect<Equal<Row<typeof users>, Row<typeof db.public.users>>>,
  Expect<Equal<NewRow<typeof orders>, NewRow<typeof db.public.orders>>>,
  Expect<Equal<Row<typeof sessions>, Row<typeof db.auth.sessions>>>,
];

// Never called: these exist only for the type checker.
export function rejected() {
  // @ts-expect-error identity needs an integer type
  defineTable((c) => ({ id: c.text().generatedAlwaysAsIdentity() }));

  // @ts-expect-error a composite primary key must name existing columns
  defineTable((c) => ({ id: c.text() }), { primaryKey: ["nope"] });

  // @ts-expect-error the default must match the column type
  defineTable((c) => ({ n: c.integer().default("one") }));

  // @ts-expect-error email is required on insert
  const missingEmail: NewRow<typeof db.public.users> = {};

  // @ts-expect-error an identity column cannot be inserted
  const withId: NewRow<typeof db.public.orders> = { id: 1n, user_id: "u", total: "1.00", placed_on: "2026-10-20" };

  return [missingEmail, withId];
}
