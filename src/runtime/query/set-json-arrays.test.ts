import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: {
    documents: defineTable((c) => ({
      id: c.integer().notNull(),
      value: c.jsonb<number[]>().notNull(),
    })),
  },
});

describe("set matches on array-valued JSON", () => {
  it("treats each JSON array as one value for in and notIn", async () => {
    await testDatabase.driver.execute(
      "create table public.documents (id integer not null, value jsonb not null); insert into public.documents values (1, '[1,2]'), (2, '[3]')",
    );
    const query = from(db.public.documents);

    expect(await client.all(query.where((d) => d.value.in([[1, 2]])).pick("id"))).toStrictEqual([
      { id: 1 },
    ]);
    expect(await client.all(query.where((d) => d.value.notIn([[1, 2]])).pick("id"))).toStrictEqual([
      { id: 2 },
    ]);
  });
});
