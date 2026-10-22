import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./catalog.ts";

describe("definitionCatalog", () => {
  it("has a fact per schema, table, and column, keyed by dotted path", () => {
    const users = defineTable((c) => ({ id: c.text().notNull(), email: c.text() }));
    const sessions = defineTable((c) => ({ token: c.text() }));
    const catalog = definitionCatalog(defineDatabase({ public: { users }, auth: { sessions } }));

    expect([...catalog]).toStrictEqual([
      ["public", { kind: "schema", name: "public", parent: undefined, payload: {} }],
      ["public.users", { kind: "table", name: "users", parent: "public", payload: {} }],
      [
        "public.users.id",
        {
          kind: "column",
          name: "id",
          parent: "public.users",
          payload: { type: "text", notNull: true },
        },
      ],
      [
        "public.users.email",
        {
          kind: "column",
          name: "email",
          parent: "public.users",
          payload: { type: "text", notNull: false },
        },
      ],
      ["auth", { kind: "schema", name: "auth", parent: undefined, payload: {} }],
      ["auth.sessions", { kind: "table", name: "sessions", parent: "auth", payload: {} }],
      [
        "auth.sessions.token",
        {
          kind: "column",
          name: "token",
          parent: "auth.sessions",
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
