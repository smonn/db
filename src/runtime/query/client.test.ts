import { describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
  },
});

describe("client.all", () => {
  it("reads typed rows back from a hand-made table", async () => {
    await testDatabase.driver.execute(`
      create table public.users (id text not null, email text);
      insert into public.users values ('u1', 'a@example.com'), ('u2', null);
    `);

    const everything = await client.all(from(db.public.users));
    expect(everything).toStrictEqual([
      { id: "u1", email: "a@example.com" },
      { id: "u2", email: null },
    ]);
    expectTypeOf(everything).toEqualTypeOf<{ id: string; email: string | null }[]>();

    const renamed = await client.all(from(db.public.users).select((u) => ({ mail: u.email })));
    expect(renamed).toStrictEqual([{ mail: "a@example.com" }, { mail: null }]);
    expectTypeOf(renamed).toEqualTypeOf<{ mail: string | null }[]>();
  });

  it("runs inside a transaction through the transaction's client", async () => {
    await testDatabase.driver.execute("create table public.notes (body text)");
    const notes = defineDatabase({ public: { notes: defineTable((c) => ({ body: c.text() })) } });

    const rows = await testDatabase.driver.transaction(async (tx) => {
      await tx.execute("insert into public.notes values ('draft')");
      return createClient(tx).all(from(notes.public.notes));
    });
    expect(rows).toStrictEqual([{ body: "draft" }]);
  });
});
