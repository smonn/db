import { describe, expect, expectTypeOf, it } from "vitest";
import { defineTable, type Row } from "./index.ts";

describe("a column's identity mode", () => {
  it("is the mode .identity() was given", () => {
    const t = defineTable((c) => ({
      always: c.integer().identity("always"),
      byDefault: c.integer().identity("by default"),
      implied: c.integer().identity(),
    }));
    type Mode<K extends keyof typeof t.columns> = (typeof t.columns)[K]["~types"]["identityMode"];

    expectTypeOf<Mode<"always">>().toEqualTypeOf<"always">();
    expectTypeOf<Mode<"byDefault">>().toEqualTypeOf<"by default">();
    expectTypeOf<Mode<"implied">>().toEqualTypeOf<"by default">();
    expect(t.columns.always.state.identity).toBe("always");
    expect(t.columns.implied.state.identity).toBe("by default");
  });

  it("includes the default when the supplied mode can be undefined", () => {
    const t = defineTable((c) => {
      const identity = (mode: "always" | undefined) => c.integer().identity(mode);
      return { id: identity(undefined) };
    });

    expectTypeOf<(typeof t.columns.id)["~types"]["identityMode"]>().toEqualTypeOf<
      "always" | "by default"
    >();
    expect(t.columns.id.state.identity).toBe("by default");
  });

  it("is none for a column without an identity", () => {
    const t = defineTable((c) => ({
      id: c.integer().primaryKey(),
      n: c.integer().default("1"),
      email: c.text().notNull().unique(),
      tags: c.text().array(),
    }));

    expectTypeOf<(typeof t.columns.id)["~types"]["identityMode"]>().toEqualTypeOf<undefined>();
    expectTypeOf<(typeof t.columns.n)["~types"]["identityMode"]>().toEqualTypeOf<undefined>();
    expectTypeOf<(typeof t.columns.email)["~types"]["identityMode"]>().toEqualTypeOf<undefined>();
    expectTypeOf<(typeof t.columns.tags)["~types"]["identityMode"]>().toEqualTypeOf<undefined>();
    expect(t.columns.id.state.identity).toBeUndefined();
  });

  it("survives every modifier and .codec()", () => {
    const t = defineTable((c) => ({
      id: c
        .integer()
        .identity("always")
        .primaryKey()
        .codec({ decode: (value: number) => `${value}`, encode: Number })
        .name("ident"),
    }));

    expectTypeOf<(typeof t.columns.id)["~types"]["identityMode"]>().toEqualTypeOf<"always">();
    expect(t.columns.id.state.explicitName).toBe("ident");
  });

  it("leaves the row type alone", () => {
    const t = defineTable((c) => ({
      always: c.integer().identity("always"),
      byDefault: c.integer().identity(),
      plain: c.text().notNull(),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      always: number;
      byDefault: number;
      plain: string;
    }>();
    expect(Object.keys(t.columns)).toStrictEqual(["always", "byDefault", "plain"]);
  });
});
