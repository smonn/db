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

describe("column types", () => {
  const all = defineTable((c) => ({
    text: c.text(),
    varchar: c.varchar(20),
    smallint: c.smallint(),
    integer: c.integer(),
    bigint: c.bigint(),
    numeric: c.numeric(),
    numericP: c.numeric(10),
    numericPS: c.numeric(10, 2),
    real: c.real(),
    doublePrecision: c.doublePrecision(),
    boolean: c.boolean(),
    uuid: c.uuid(),
    date: c.date(),
    timestamp: c.timestamp(),
    timestamptz: c.timestamptz(),
    jsonb: c.jsonb<{ a: number }>(),
    bytea: c.bytea(),
  }));

  it("names each type's SQL type", () => {
    const sqlTypes = Object.fromEntries(
      Object.entries(all.columns).map(([key, col]) => [key, col.state.sqlType]),
    );
    expect(sqlTypes).toStrictEqual({
      text: "text",
      varchar: "varchar(20)",
      smallint: "smallint",
      integer: "integer",
      bigint: "bigint",
      numeric: "numeric",
      numericP: "numeric(10)",
      numericPS: "numeric(10,2)",
      real: "real",
      doublePrecision: "double precision",
      boolean: "boolean",
      uuid: "uuid",
      date: "date",
      timestamp: "timestamp",
      timestamptz: "timestamptz",
      jsonb: "jsonb",
      bytea: "bytea",
    });
  });

  it("makes every type nullable by default", () => {
    expect(Object.values(all.columns).every((col) => !col.state.notNull)).toBe(true);
  });

  it("keeps the SQL type through notNull", () => {
    expect(all.columns.numericPS.notNull().state).toStrictEqual({
      sqlType: "numeric(10,2)",
      notNull: true,
    });
  });

  it("types each column's row value", () => {
    expectTypeOf<Row<typeof all>>().toEqualTypeOf<{
      text: string | null;
      varchar: string | null;
      smallint: number | null;
      integer: number | null;
      bigint: bigint | null;
      numeric: string | null;
      numericP: string | null;
      numericPS: string | null;
      real: number | null;
      doublePrecision: number | null;
      boolean: boolean | null;
      uuid: string | null;
      date: string | null;
      timestamp: Date | null;
      timestamptz: Date | null;
      jsonb: { a: number } | null;
      bytea: Uint8Array | null;
    }>();
  });

  it("types jsonb as unknown without a type argument, and notNull drops null", () => {
    const t = defineTable((c) => ({ a: c.jsonb(), b: c.bigint().notNull() }));
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ a: unknown; b: bigint }>();
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
