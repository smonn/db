import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable, type Row } from "./definition.ts";

const users = defineTable((c) => ({
  id: c.text().notNull(),
  email: c.text(),
}));

describe("defineTable", () => {
  it("makes columns nullable unless marked notNull", () => {
    expect(users.columns.id.state).toStrictEqual({ sqlType: "text", notNull: true });
    expect(users.columns.email.state).toStrictEqual({ sqlType: "text", notNull: false });
  });

  it("leaves the column notNull was called on unchanged", () => {
    users.columns.email.notNull();
    expect(users.columns.email.state.notNull).toBe(false);
  });
});

describe("defineDatabase", () => {
  it("names schemas and tables by their keys", () => {
    const sessions = defineTable((c) => ({ token: c.text() }));
    const db = defineDatabase({ public: { users }, auth: { sessions } });
    expect(db.public.users).toStrictEqual({
      schema: "public",
      name: "users",
      columns: users.columns,
    });
    expect(db.auth.sessions).toStrictEqual({
      schema: "auth",
      name: "sessions",
      columns: sessions.columns,
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
