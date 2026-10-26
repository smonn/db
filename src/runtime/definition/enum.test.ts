import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineEnum, defineTable, type Row } from "./index.ts";

describe("defineEnum", () => {
  it("keeps its labels in order", () => {
    expect(defineEnum(["sad", "ok"]).labels).toStrictEqual(["sad", "ok"]);
  });

  it("types a column as the union of its labels", () => {
    const mood = defineEnum(["sad", "ok"]);
    const users = defineTable((c) => ({
      mood: c.enum(mood).notNull(),
      previous: c.enum(mood),
    }));

    expectTypeOf<Row<typeof users>>().toEqualTypeOf<{
      mood: "sad" | "ok";
      previous: "sad" | "ok" | null;
    }>();
  });

  it("holds the enum itself in the column, since the rollup names the type", () => {
    const mood = defineEnum(["sad", "ok"]);
    const users = defineTable((c) => ({ mood: c.enum(mood) }));

    expect(users.columns.mood.state).toMatchObject({ sqlType: "", enumType: mood });
  });

  it("sits in a schema beside its tables and comes back as the same value", () => {
    const mood = defineEnum(["sad", "ok"]);
    const users = defineTable((c) => ({ mood: c.enum(mood) }));
    const database = defineDatabase({ public: { mood, users } });

    expect(database.public.mood).toBe(mood);
    expect(database.public.users).toMatchObject({ schema: "public", name: "users" });
    expectTypeOf(database.public.mood.labels).toEqualTypeOf<readonly ["sad", "ok"]>();
  });
});

describe("text and varchar", () => {
  it("narrow the TypeScript type only", () => {
    const t = defineTable((c) => ({
      status: c.text<"open" | "closed">().notNull(),
      code: c.varchar<"a" | "b">(1).notNull(),
      plain: c.text().notNull(),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      status: "open" | "closed";
      code: "a" | "b";
      plain: string;
    }>();
    expect(t.columns.status.state.sqlType).toBe("text");
    expect(t.columns.code.state.sqlType).toBe("varchar(1)");
  });
});
