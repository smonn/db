import { describe, expect, it } from "vitest";
import { sql } from "../query/index.ts";
import { defineDatabase } from "./database.ts";
import { defineTable } from "./definition.ts";
import { defineEnum } from "./enum.ts";
import { sqlDefinition } from "./sql-definition.ts";
import type { TableDefinition } from "./table.ts";

const userAccounts = () => defineTable((c) => ({ userId: c.text() }));

describe("sqlDefinition without the view defineDatabase keeps", () => {
  it("refuses a copy whose tables' SQL names differ from their keys", () => {
    const db = defineDatabase(
      { appData: { userAccounts: userAccounts() } },
      { casing: "snake_case" },
    );
    expect(() => sqlDefinition({ ...db })).toThrow(
      'The Definition names "appData"."userAccounts" by its keys, though defineDatabase mapped it to SQL names; pass the object defineDatabase returned, not a copy such as { ...db }',
    );
  });

  it("refuses a column whose SQL name differs from its key", () => {
    const people = defineTable((c) => ({ id: c.text().name("person_id") }));
    const db = defineDatabase({ public: { people } });
    expect(() => sqlDefinition({ ...db })).toThrow('names "public"."people" by its keys');
  });

  it("refuses a type whose explicit name differs from its key", () => {
    const db = defineDatabase({ public: { mood: defineEnum(["a"], { name: "feeling" }) } });
    expect(() => sqlDefinition({ ...db })).toThrow('names "public"."mood" by its keys');
  });

  it("reads a copy whose keys are its SQL names", () => {
    const db = defineDatabase({ public: { users: userAccounts(), mood: defineEnum(["a"]) } });
    const copy = { ...db };
    expect(sqlDefinition(copy)).toBe(copy);
  });
});

/** The table with index objects this copy of the package didn't build, as another copy's would be. */
const foreignCopy = (table: TableDefinition): TableDefinition => ({
  ...table,
  indexes: table.indexes.map((index) => ({
    ...index,
    keys: index.keys.map((key) => ({ ...key })),
  })),
});

const people = () =>
  defineTable(
    (c) => ({ firstName: c.text() }),
    (t) => ({ indexes: [{ name: "people_first", columns: [sql`lower(${t.firstName})`] }] }),
  );

const wherePeople = () =>
  defineTable(
    (c) => ({ firstName: c.text() }),
    (t) => ({ indexes: [{ columns: [t.firstName], where: sql`${t.firstName} <> ''` }] }),
  );

describe("the SQL view of an index expression", () => {
  it("refuses an expression key it can't rename", () => {
    expect(() =>
      defineDatabase({ public: { people: foreignCopy(people()) } }, { casing: "snake_case" }),
    ).toThrow(
      `An index of "public"."people" holds an expression that another copy of @smonn/db built, so its columns can't take their SQL names; take defineTable and defineDatabase from one copy of the package`,
    );
  });

  it("refuses a WHERE predicate it can't rename", () => {
    expect(() =>
      defineDatabase({ public: { people: foreignCopy(wherePeople()) } }, { casing: "snake_case" }),
    ).toThrow('An index of "public"."people" holds an expression that another copy');
  });

  it("keeps the text when no column changes its name", () => {
    const db = defineDatabase({ public: { people: foreignCopy(people()) } });
    expect(sqlDefinition(db)).toHaveProperty(
      ["public", "people", "indexes", 0, "keys", 0, "expression"],
      'lower("firstName")',
    );
  });
});
