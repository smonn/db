import { describe, expect, expectTypeOf, it } from "vitest";
import { defineEnum, defineTable, type Row } from "./index.ts";

describe(".array()", () => {
  it("types the column as an array of nullable elements, nullable itself", () => {
    const t = defineTable((c) => ({
      tags: c.text().array(),
      scores: c.integer().array().notNull(),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      tags: (string | null)[] | null;
      scores: (number | null)[];
    }>();
  });

  it("makes .notNull() and .default() mean the whole column", () => {
    const t = defineTable((c) => ({
      tags: c.text().array().notNull().default("'{}'"),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{ tags: (string | null)[] }>();
    expect(t.columns.tags.state).toMatchObject({ array: true, notNull: true, default: "'{}'" });
  });

  it("keeps the element type in state and flags the array", () => {
    const mood = defineEnum(["sad", "ok"]);
    const t = defineTable((c) => ({
      names: c.varchar(20).array(),
      moods: c.enum(mood).array().notNull(),
      plain: c.text(),
    }));

    expect(t.columns.names.state).toMatchObject({ sqlType: "varchar(20)", array: true });
    expect(t.columns.moods.state).toMatchObject({ sqlType: "", enumType: mood, array: true });
    expect(t.columns.plain.state.array).toBe(false);
    expectTypeOf<Row<typeof t>["moods"]>().toEqualTypeOf<("sad" | "ok" | null)[]>();
  });

  it("allows .renamedFrom() first, which is no modifier", () => {
    const t = defineTable((c) => ({ tags: c.text().renamedFrom("labels").array() }));

    expect(t.columns.tags.state).toMatchObject({ array: true, renamedFrom: "labels" });
  });

  it("is absent from the type once a modifier or .array() ran", () => {
    const { columns } = defineTable((c) => ({
      notNull: c.text().notNull(),
      defaulted: c.text().default("'x'"),
      identity: c.integer().identity(),
      unique: c.text().unique(),
      codec: c.text().codec({ decode: (value) => value, encode: (value) => value }),
      twice: c.text().array(),
    }));

    expectTypeOf(columns.notNull).not.toHaveProperty("array");
    expectTypeOf(columns.defaulted).not.toHaveProperty("array");
    expectTypeOf(columns.identity).not.toHaveProperty("array");
    expectTypeOf(columns.unique).not.toHaveProperty("array");
    expectTypeOf(columns.codec).not.toHaveProperty("array");
    expectTypeOf(columns.twice).not.toHaveProperty("array");

    /* oxlint-disable typescript/no-unsafe-call -- the missing method is the point. */
    // @ts-expect-error -- .array() comes before any modifier
    columns.notNull.array();
    // @ts-expect-error -- a second .array() would ask for two dimensions
    columns.twice.array();
    /* oxlint-enable typescript/no-unsafe-call */
  });

  it("gives an array column no identity", () => {
    const { columns } = defineTable((c) => ({ a: c.integer().array() }));

    expectTypeOf(columns.a).not.toHaveProperty("identity");
  });
});
