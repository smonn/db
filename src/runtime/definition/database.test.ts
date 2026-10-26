import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable, type Row } from "./definition.ts";

const users = defineTable((c) => ({
  id: c.text().notNull(),
  email: c.text(),
}));

describe("defineDatabase", () => {
  it("names schemas and tables by their keys", () => {
    const sessions = defineTable((c) => ({ token: c.text() }));
    const db = defineDatabase({ public: { users }, auth: { sessions } });
    const bare = {
      primaryKey: [],
      primaryKeyName: undefined,
      uniques: [],
      declaredForeignKeys: [],
      indexes: [],
      renamedFrom: undefined,
      foreignKeys: [],
    };
    expect(db.public.users).toStrictEqual({
      schema: "public",
      name: "users",
      columns: users.columns,
      ...bare,
    });
    expect(db.auth.sessions).toStrictEqual({
      schema: "auth",
      name: "sessions",
      columns: sessions.columns,
      ...bare,
    });
  });

  it("infers a row type from a standalone or rolled-up table", () => {
    const db = defineDatabase({ public: { users } });
    expectTypeOf<Row<typeof users>>().toEqualTypeOf<{ id: string; email: string | null }>();
    expectTypeOf<Row<typeof db.public.users>>().toEqualTypeOf<{
      id: string;
      email: string | null;
    }>();
  });
});
