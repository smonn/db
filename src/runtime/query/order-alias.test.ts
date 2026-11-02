import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: {
    scores: defineTable((c) => ({ id: c.integer().notNull(), points: c.integer().notNull() })),
  },
});

describe("orderBy with a colliding output alias", () => {
  it("orders the input column for bare, ascending and descending orderings", async () => {
    await testDatabase.driver.execute(
      "create table public.scores (id integer not null, points integer not null); insert into public.scores values (1, 20), (2, 10)",
    );
    const selected = from(db.public.scores).select((s) => ({ id: s.points }));
    const ascending = [{ id: 20 }, { id: 10 }];

    expect(await client.all(selected.orderBy((s) => s.id))).toStrictEqual(ascending);
    expect(await client.all(selected.orderBy((s) => s.id.asc()))).toStrictEqual(ascending);
    expect(await client.all(selected.orderBy((s) => s.id.desc()))).toStrictEqual([
      { id: 10 },
      { id: 20 },
    ]);
  });
});
