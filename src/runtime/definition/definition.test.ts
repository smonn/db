import { assert, describe, expect, expectTypeOf, it } from "vitest";
import type { ColumnFactories } from "./column.ts";
import { defineDatabase, defineTable, type Refs, type Row } from "./definition.ts";

const users = defineTable((c) => ({
  id: c.text().notNull(),
  email: c.text(),
}));

const pair = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer() });

const PLAIN = {
  sqlType: "",
  notNull: false,
  default: undefined,
  identity: undefined,
  primaryKey: false,
  unique: false,
};

describe("defineTable", () => {
  it("makes columns nullable unless marked notNull", () => {
    expect(users.columns.id.state).toStrictEqual({ ...PLAIN, sqlType: "text", notNull: true });
    expect(users.columns.email.state).toStrictEqual({ ...PLAIN, sqlType: "text", notNull: false });
  });

  it("declares a default, identity, primary key, and unique constraint", () => {
    const t = defineTable((c) => ({
      a: c.text().default("'new'"),
      b: c.integer().identity(),
      c: c.bigint().identity("always"),
      d: c.uuid().primaryKey(),
      e: c.text().unique(),
    }));
    expect(t.columns.a.state).toMatchObject({ default: "'new'", notNull: false });
    expect(t.columns.b.state).toMatchObject({ identity: "by default", notNull: true });
    expect(t.columns.c.state).toMatchObject({ identity: "always", notNull: true });
    expect(t.columns.d.state).toMatchObject({ primaryKey: true, notNull: true });
    expect(t.columns.e.state).toMatchObject({ unique: true, notNull: false });
  });

  it("allows an identity on integer types only, and not alongside a default", () => {
    defineTable((c) => ({
      a: c.smallint().identity(),
      b: c.integer().identity(),
      c: c.bigint().identity(),
      d: c.integer().default("1"),
    }));
    /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call -- each missing method is the point. */
    const rejected = [
      defineTable((c) => {
        // @ts-expect-error -- text can't be an identity.
        return { e: c.text().identity() };
      }),
      defineTable((c) => {
        // @ts-expect-error -- real can't be an identity.
        return { f: c.real().identity() };
      }),
      defineTable((c) => {
        // @ts-expect-error -- an identity can't have a default.
        return { g: c.integer().identity().default("1") };
      }),
      defineTable((c) => {
        // @ts-expect-error -- a default column can't be an identity.
        return { h: c.integer().default("1").identity() };
      }),
      defineTable((c) => {
        // @ts-expect-error -- double precision can't be an identity.
        return { i: c.doublePrecision().identity() };
      }),
    ];
    /* oxlint-enable typescript/no-unsafe-assignment, typescript/no-unsafe-call */
    expect(rejected).toHaveLength(5);
  });

  it("types primary key and identity columns as NOT NULL", () => {
    const t = defineTable((c) => ({ id: c.integer().primaryKey(), n: c.integer().identity() }));
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ id: number; n: number }>();
  });

  it("declares a composite primary key in the second callback, in the written order", () => {
    const t = defineTable(
      (c) => ({ a: c.integer(), b: c.integer(), n: c.text() }),
      (r) => ({ primaryKey: [r.b, r.a] }),
    );
    expect(t.primaryKey).toStrictEqual(["b", "a"]);
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ a: number; b: number; n: string | null }>();
  });

  it("records a single-column key from the column", () => {
    const t = defineTable((c) => ({ id: c.integer().primaryKey(), n: c.text() }));
    expect(t.primaryKey).toStrictEqual(["id"]);
    expect(users.primaryKey).toStrictEqual([]);
  });

  it("fails at load on a key declared twice, on several columns, or on a bad reference", () => {
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer().primaryKey(), b: c.integer() }),
        // @ts-expect-error -- a column key and a callback key can't both be declared.
        (r) => ({ primaryKey: [r.a, r.b] }),
      ),
    ).toThrow('Column "a" calls primaryKey() and the table\'s second callback also declares');
    expect(() =>
      // @ts-expect-error -- primaryKey() on two columns needs the second callback.
      defineTable((c) => ({ a: c.integer().primaryKey(), b: c.integer().primaryKey() })),
    ).toThrow('Columns "a", "b" each call primaryKey()');
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        // @ts-expect-error -- "z" is not a column.
        (r) => ({ primaryKey: [r.a, r.z] }),
      ),
    ).toThrow("not one of its columns");
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        (r) => ({ primaryKey: [r.a, r.a] }),
      ),
    ).toThrow('lists "a" twice');
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer() }),
        // @ts-expect-error -- a single column goes on the column.
        (r) => ({ primaryKey: [r.a] }),
      ),
    ).toThrow("fewer than two columns");
  });

  it("rejects another table's references, by type where the columns differ and at load always", () => {
    const held: { refs?: Refs<ReturnType<typeof pair>> } = {};
    defineTable(pair, (t) => {
      held.refs = t;
      return {};
    });
    const foreign = held.refs;
    assert(foreign !== undefined);
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer(), n: c.text() }),
        // @ts-expect-error -- "b" belongs to a table with other columns.
        (r) => ({ primaryKey: [r.a, foreign.b] }),
      ),
    ).toThrow('The table\'s primaryKey takes "b" from another table');
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.text() }),
        // @ts-expect-error -- "b" belongs to a table whose "b" has another type.
        (r) => ({ primaryKey: [r.a, foreign.b] }),
      ),
    ).toThrow('takes "b" from another table');
    // The types compare tables by their columns, so only the load check catches a table with the same ones.
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        (r) => ({ primaryKey: [r.a, foreign.b] }),
      ),
    ).toThrow('takes "b" from another table');
  });

  it("has no second primaryKey() on a column that already is the key", () => {
    /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call -- the missing method is the point. */
    const t = defineTable((c) => {
      // @ts-expect-error -- the column already is the primary key.
      return { a: c.integer().primaryKey().primaryKey() };
    });
    /* oxlint-enable typescript/no-unsafe-assignment, typescript/no-unsafe-call */
    expect(t.primaryKey).toStrictEqual(["a"]);
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
      ...PLAIN,
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
      primaryKey: [],
    });
    expect(db.auth.sessions).toStrictEqual({
      schema: "auth",
      name: "sessions",
      columns: sessions.columns,
      primaryKey: [],
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
