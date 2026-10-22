import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { catalogBuilder, childrenOf, definitionCatalog, namesOf, parentOf } from "./catalog.ts";

describe("definitionCatalog", () => {
  it("has a fact per schema, table, and column, keyed by their chain of names", () => {
    const users = defineTable((c) => ({ id: c.text().notNull(), email: c.text() }));
    const sessions = defineTable((c) => ({ token: c.text() }));
    const catalog = definitionCatalog(defineDatabase({ public: { users }, auth: { sessions } }));

    expect([...catalog]).toStrictEqual([
      ["public", { kind: "schema", name: "public", parent: undefined, payload: {} }],
      ["public\0users", { kind: "table", name: "users", parent: "public", payload: {} }],
      [
        "public\0users\0id",
        {
          kind: "column",
          name: "id",
          parent: "public\0users",
          payload: { type: "text", notNull: true },
        },
      ],
      [
        "public\0users\0email",
        {
          kind: "column",
          name: "email",
          parent: "public\0users",
          payload: { type: "text", notNull: false },
        },
      ],
      ["auth", { kind: "schema", name: "auth", parent: undefined, payload: {} }],
      ["auth\0sessions", { kind: "table", name: "sessions", parent: "auth", payload: {} }],
      [
        "auth\0sessions\0token",
        {
          kind: "column",
          name: "token",
          parent: "auth\0sessions",
          payload: { type: "text", notNull: false },
        },
      ],
    ]);
  });

  it("keeps a schema with no tables", () => {
    expect([...definitionCatalog(defineDatabase({ empty: {} }))]).toStrictEqual([
      ["empty", { kind: "schema", name: "empty", parent: undefined, payload: {} }],
    ]);
  });
});

describe("catalogBuilder", () => {
  it("refuses a table or column whose parent it hasn't added, naming it", () => {
    const builder = catalogBuilder();
    expect(() => {
      builder.table("auth", "users");
    }).toThrow(`schema "auth" isn't in the catalog`);
    builder.schema("auth");
    expect(() => {
      builder.column("auth", "users", "id", { type: "text", notNull: false });
    }).toThrow(`table "auth"."users" isn't in the catalog`);
  });
});

describe("lookups", () => {
  const users = defineTable((c) => ({ id: c.text(), email: c.text() }));
  const catalog = definitionCatalog(
    defineDatabase({ public: { users, empty: defineTable(() => ({})) } }),
  );
  const fact = (name: string) => [...catalog.values()].find((f) => f.name === name)!;

  it("finds a fact's parent and its children in catalog order", () => {
    expect(parentOf(catalog, fact("email"))).toBe(fact("users"));
    expect(childrenOf(catalog, fact("users"))).toStrictEqual([fact("id"), fact("email")]);
    expect(childrenOf(catalog, fact("empty"))).toStrictEqual([]);
  });

  it("names a fact from its schema down", () => {
    expect(namesOf(catalog, fact("email"))).toStrictEqual(["public", "users", "email"]);
    expect(namesOf(catalog, fact("public"))).toStrictEqual(["public"]);
  });

  it("refuses the parent of a schema", () => {
    expect(() => parentOf(catalog, fact("public"))).toThrow("schema public has no parent");
  });
});
