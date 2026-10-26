import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("an index and a foreign key that share a name", () => {
  it("both reach Postgres and read back, and the re-diff is empty", async () => {
    const parent = defineTable((c) => ({ id: c.integer().primaryKey() }));
    const wanted = definitionCatalog(
      defineDatabase({
        public: {
          parent,
          child: defineTable(
            (c) => ({ p: c.integer().references(() => parent.columns.id, { name: "same" }) }),
            (r) => ({ indexes: [{ columns: [r.p], name: "same" }] }),
          ),
        },
      }),
    );

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const after = await introspect(db.driver);
    expect(
      [...after.values()].filter(({ name }) => name === "same").map(({ kind }) => kind),
    ).toStrictEqual(["index", "foreign key"]);
    expect(diff(after, wanted)).toBe("");
  });
});
