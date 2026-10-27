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

  it("reads a copy whose view slot holds no object as having no view", () => {
    for (const slot of [null, "view", 3]) {
      const db = defineDatabase({ public: { users: userAccounts() } });
      const copy = { ...db };
      Object.defineProperty(copy, Symbol.for("@smonn/db.sqlDefinition"), { value: slot });
      expect(sqlDefinition(copy)).toBe(copy);
    }
  });

  it("reads a copy whose type has an explicit name equal to its key", () => {
    const db = defineDatabase({ public: { mood: defineEnum(["a"], { name: "mood" }) } });
    const copy = { ...db };
    expect(sqlDefinition(copy)).toBe(copy);
  });

  it("refuses a table moved to another schema or key of the copy", () => {
    const db = defineDatabase({ public: { users: userAccounts() } });
    expect(() => sqlDefinition({ archive: { users: db.public.users } })).toThrow(
      'names "archive"."users" by its keys',
    );
    expect(() => sqlDefinition({ public: { members: db.public.users } })).toThrow(
      'names "public"."members" by its keys',
    );
  });

  it("refuses a table of which only some columns change their name", () => {
    const people = defineTable((c) => ({ id: c.text().name("person_id"), email: c.text() }));
    const db = defineDatabase({ public: { people } });
    expect(() => sqlDefinition({ ...db })).toThrow('names "public"."people" by its keys');
  });
});

describe("the view defineDatabase keeps", () => {
  it("sits under a symbol shared across copies of the package, out of sight of the keys", () => {
    const db = defineDatabase({ public: { users: userAccounts() } }, { casing: "snake_case" });
    const view: unknown = Reflect.get(db, Symbol.for("@smonn/db.sqlDefinition"));

    expect(view).toBe(sqlDefinition(db));
    expect(view).toHaveProperty(["public", "users", "columns", "user_id"]);
    expect(Object.keys(db)).toStrictEqual(["public"]);
  });

  it("names the columns of a declared foreign key by their SQL names", () => {
    const parent = defineTable((c) => ({ id: c.integer().primaryKey() }));
    const references = () => [parent.columns.id] as const;
    const child = defineTable(
      (c) => ({
        rootId: c.integer().unique(),
        parentId: c.integer(),
        otherId: c.integer(),
      }),
      (t) => ({
        foreignKeys: [
          { columns: [t.parentId], references: [t.rootId] },
          { columns: [t.otherId], references },
        ],
      }),
    );
    const db = defineDatabase({ public: { parent, child } }, { casing: "snake_case" });

    expect(sqlDefinition(db)).toMatchObject({
      public: {
        child: {
          declaredForeignKeys: [
            { columns: ["parent_id"], references: ["root_id"] },
            { columns: ["other_id"], references },
          ],
        },
      },
    });
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

  it("refuses an expression key it can't rename when only some columns change their name", () => {
    const mixed = defineTable(
      (c) => ({ id: c.text(), firstName: c.text() }),
      (t) => ({ indexes: [{ name: "mixed_first", columns: [sql`lower(${t.firstName})`] }] }),
    );
    expect(() =>
      defineDatabase({ public: { mixed: foreignCopy(mixed) } }, { casing: "snake_case" }),
    ).toThrow('An index of "public"."mixed" holds an expression that another copy');
  });

  it("keeps the text when no column changes its name", () => {
    const db = defineDatabase({ public: { people: foreignCopy(people()) } });
    expect(sqlDefinition(db)).toHaveProperty(
      ["public", "people", "indexes", 0, "keys", 0, "expression"],
      'lower("firstName")',
    );
  });
});
