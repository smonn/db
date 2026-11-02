import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { update } from "./update.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.integer().notNull(), name: c.text().notNull() })),
  },
});

describe("update with a missing where return", () => {
  it("refuses count and returning execution and preserves every row", async () => {
    await testDatabase.driver.execute(
      "create table public.users (id integer not null, name text not null); insert into public.users values (1, 'a'), (2, 'b')",
    );
    const missing = () =>
      update(db.public.users)
        .set({ name: "z" })
        // @ts-expect-error a JavaScript callback can forget to return its predicate
        .where((u) => {
          void u.id.eq(1);
        });
    const message = "update.where callback must return a predicate";

    await expect(async () => {
      await client.run(missing());
    }).rejects.toThrow(message);
    await expect(async () => {
      await client.all(missing().returning((u) => ({ id: u.id })));
    }).rejects.toThrow(message);
    await expect(async () => {
      await client.run(
        update(db.public.users)
          .set({ name: "z" })
          .where((u) => u.id.eq(1))
          // @ts-expect-error a chained callback can forget to return its predicate too
          .where((u) => {
            void u.id.eq(2);
          }),
      );
    }).rejects.toThrow(message);
    expect(await client.all(from(db.public.users).orderBy((u) => u.id))).toStrictEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });
});
