import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable, type Row } from "./definition.ts";

describe("a key's constraint name", () => {
  it("is left to the catalog unless the Definition gives one", () => {
    const t = defineTable((c) => ({ id: c.integer().primaryKey(), email: c.text().unique() }));
    expect(t.primaryKeyName).toBeUndefined();
    expect(t.columns.email.state.constraintName).toBeUndefined();
  });

  it("comes from primaryKey({ name }) and unique({ name }) on a column", () => {
    const t = defineTable((c) => ({
      id: c.integer().primaryKey({ name: "pk_users" }).identity(),
      email: c.text().unique({ name: "uq_email" }).notNull(),
    }));
    expect(t.primaryKey).toStrictEqual(["id"]);
    expect(t.primaryKeyName).toBe("pk_users");
    expect(t.columns.id.state).toMatchObject({ primaryKey: true, constraintName: "pk_users" });
    expect(t.columns.email.state).toMatchObject({ unique: true, constraintName: "uq_email" });
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ id: number; email: string }>();
  });

  it("comes from { name, columns } in the second callback, keeping the key's columns and order", () => {
    const t = defineTable(
      (c) => ({ a: c.integer(), b: c.integer(), n: c.text() }),
      (r) => ({ primaryKey: { name: "pk_pair", columns: [r.b, r.a] } }),
    );
    expect(t.primaryKey).toStrictEqual(["b", "a"]);
    expect(t.primaryKeyName).toBe("pk_pair");
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ a: number; b: number; n: string | null }>();
    expect(defineDatabase({ public: { t } }).public.t.primaryKeyName).toBe("pk_pair");
  });

  it("is a string, and { name, columns } needs both", () => {
    const rejected = [
      // @ts-expect-error -- a name is a string.
      defineTable((c) => ({ a: c.integer().primaryKey({ name: 1 }) })),
      // @ts-expect-error -- the options need a name.
      defineTable((c) => ({ a: c.integer().unique({}) })),
    ];
    expect(rejected).toHaveLength(2);
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        // @ts-expect-error -- a name is a string.
        (r) => ({ primaryKey: { name: 1, columns: [r.a, r.b] } }),
      ),
    ).toThrow("The table's primaryKey takes a list of columns or { name, columns }");
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        // @ts-expect-error -- a named key needs its name.
        (r) => ({ primaryKey: { columns: [r.a, r.b] } }),
      ),
    ).toThrow("The table's primaryKey takes a list of columns or { name, columns }");
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        // @ts-expect-error -- a named key needs its columns.
        () => ({ primaryKey: { name: "pk" } }),
      ),
    ).toThrow("fewer than two columns");
    expect(() =>
      defineTable(
        (c) => ({ a: c.integer(), b: c.integer() }),
        (r) => ({ primaryKey: { name: "pk", columns: [r.a, r.a] } }),
      ),
    ).toThrow('lists "a" twice');
  });
});

describe("a column that is the primary key", () => {
  it("has no unique() of its own, by type and at load", () => {
    /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- the missing method is the point. */
    expect(() =>
      defineTable((c) => {
        // @ts-expect-error -- a primary key is already unique.
        return { id: c.integer().primaryKey().unique() };
      }),
    ).toThrow('Column "id" calls both primaryKey() and unique(); a primary key is already unique');
    expect(() =>
      defineTable((c) => {
        // @ts-expect-error -- a unique column can't then become the primary key.
        return { id: c.integer().unique().primaryKey() };
      }),
    ).toThrow('Column "id" calls both primaryKey() and unique()');
    const twice = defineTable((c) => {
      // @ts-expect-error -- the column is already unique.
      return { email: c.text().unique().unique() };
    });
    expect(twice.columns.email.state.unique).toBe(true);
    /* oxlint-enable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access */
  });

  it("can still be unique on its own when it is part of a composite key", () => {
    const t = defineTable(
      (c) => ({ a: c.integer().unique(), b: c.integer() }),
      (r) => ({ primaryKey: [r.a, r.b] }),
    );
    expect(t.columns.a.state).toMatchObject({ unique: true, primaryKey: false });
  });
});
