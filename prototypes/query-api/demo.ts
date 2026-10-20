// Prints the SQL each variant sends. A fake Driver logs the statement and
// returns no rows, so no database is needed.

import * as A from "./a-query-values/lib.ts";
import * as B from "./b-bound-client/lib.ts";
import db from "./db.ts";
import type { Driver } from "./query.ts";

const { users, orders } = db.public;

const driver: Driver = {
  query: async (statement) => {
    console.log(`  ${statement.text}\n    ${JSON.stringify(statement.values, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
    return { rows: [], count: 0 };
  },
};

console.log("A: query values run by a client");
const client = A.createClient(driver);
const adults = A.from(users)
  .where((u) => u.age.gte(18).and(u.is_admin.eq(false)))
  .select((u) => ({ id: u.id, name: u.display_name }));
await client.all(adults);
await client.all(A.from(orders).where((o, { or }) => or(o.quantity.gt(10), o.shipped_at.isNull(), o.id.in([1n, 2n]))));
await client.all(
  A.insert(orders)
    .values([
      { user_id: "u1", total: "9.99", placed_on: "2026-10-20" },
      { user_id: "u2", total: "5.00", placed_on: "2026-10-20", metadata: { gift: true } },
    ])
    .returning("id"),
);
await client.run(A.insert(users).values([{ email: "a@b.c" }, { email: "d@e.f", age: 30 }]));

console.log("\nB: builders awaited on a bound client");
const bound = B.connect(driver);
await bound.from(users).where((u) => u.email.ilike("%@example.com")).select("id", "email");
await bound.insert(users).values({ email: "a@b.c" });
