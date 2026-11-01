import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { deleteFrom } from "./delete.ts";
import { from } from "./from.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.integer().notNull() })) },
});

describe("deleteFrom with a missing where return", () => {
  it("refuses count and returning execution and preserves every row", async () => {
    await testDatabase.driver.execute(
      "create table public.users (id integer not null); insert into public.users values (1), (2)",
    );
    const missing = () =>
      // @ts-expect-error a JavaScript callback can forget to return its predicate
      deleteFrom(db.public.users).where((u) => {
        void u.id.eq(1);
      });
    const message = "deleteFrom.where callback must return a predicate";

    await expect(async () => {
      await client.run(missing());
    }).rejects.toThrow(message);
    await expect(async () => {
      await client.all(missing().returning((u) => ({ id: u.id })));
    }).rejects.toThrow(message);
    expect(await client.all(from(db.public.users).orderBy((u) => u.id))).toStrictEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });
});
