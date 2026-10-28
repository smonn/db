import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./probe-joins.ts";

// Where the decided shape compiles a query that Postgres refuses.
describe("decided shape on Postgres", () => {
  const testDatabase = useTestDatabase();
  const client = createClient(testDatabase.driver);

  it("compiles uuid = text, which Postgres refuses", async () => {
    const db = defineDatabase({
      public: {
        users: defineTable((c) => ({ id: c.uuid().primaryKey() })),
        posts: defineTable((c) => ({ title: c.text() })),
      },
    });
    await testDatabase.driver.execute(
      "create table public.users (id uuid primary key); create table public.posts (title text)",
    );
    const query = from(db.public.users)
      .innerJoin(db.public.posts, (u, p) => u.id.eq(p.title))
      .select((u) => ({ id: u.id }));
    await expect(client.all(query)).rejects.toThrow("operator does not exist: uuid = text");
  });

  it("aliases a 63-byte name to one that Postgres truncates back to the name", async () => {
    const long = "t".repeat(63);
    const db = defineDatabase({
      public: {
        nodes: defineTable(
          (c) => ({ id: c.integer(), parent: c.integer() }),
          () => ({ name: long }),
        ),
      },
    });
    await testDatabase.driver.execute(`create table public."${long}" (id int, parent int)`);
    const query = from(db.public.nodes)
      .leftJoin(db.public.nodes, (t, p) => t.parent.eq(p.id))
      .select((t) => ({ id: t.id }));
    await expect(client.all(query)).rejects.toThrow("specified more than once");
  });
});
