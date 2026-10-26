import { describe, expect, it } from "vitest";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { arrayType, elementOf } from "./column-type.ts";
import { definitionCatalog } from "./definition-catalog.ts";

describe("definitionCatalog array columns", () => {
  it("spells each type as format_type does: the element's type, then []", () => {
    const mood = defineEnum(["sad", "ok"]);
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          mood,
          t: defineTable((c) => ({
            ints: c.integer().array(),
            names: c.varchar(20).array(),
            scaled: c.numeric(10).array(),
            stamps: c.timestamptz().array(),
            moods: c.enum(mood).array().notNull(),
            plain: c.integer(),
          })),
        },
      }),
    );

    const types = Object.fromEntries(
      [...catalog.values()]
        .filter((fact) => fact.kind === "column")
        .map((f) => [f.name, f.payload]),
    );
    expect(types).toStrictEqual({
      ints: { type: "integer[]", notNull: false },
      names: { type: "character varying(20)[]", notNull: false },
      scaled: { type: "numeric(10,0)[]", notNull: false },
      stamps: { type: "timestamp with time zone[]", notNull: false },
      moods: { type: "public.mood[]", notNull: true },
      plain: { type: "integer", notNull: false },
    });
  });

  it("quotes an enum's name where format_type does", () => {
    const Mood = defineEnum(["a"]);
    const catalog = definitionCatalog(
      defineDatabase({
        "my schema": { Mood, t: defineTable((c) => ({ x: c.enum(Mood).array() })) },
      }),
    );

    expect(Object.fromEntries(catalog)["my schema\0t\0x"]).toMatchObject({
      payload: { type: '"my schema"."Mood"[]' },
    });
  });

  it("names the column when an enum array's enum is not in the Definition", () => {
    const mood = defineEnum(["a"]);

    expect(() =>
      definitionCatalog(
        defineDatabase({ public: { t: defineTable((c) => ({ x: c.enum(mood).array() })) } }),
      ),
    ).toThrow(/Column "public"\."t"\."x" uses an enum that is not in the Definition/u);
  });

  it("puts the default on the whole column", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: { t: defineTable((c) => ({ x: c.text().array().notNull().default("'{}'") })) },
      }),
    );

    expect(Object.fromEntries(catalog)["public\0t\0x\0default"]).toMatchObject({
      payload: { expression: "'{}'" },
    });
  });
});

describe("arrayType and elementOf", () => {
  it("round trip, and elementOf leaves a scalar type alone", () => {
    expect(arrayType("integer")).toBe("integer[]");
    expect(elementOf("public.mood[]")).toBe("public.mood");
    expect(elementOf(arrayType('"my schema"."Mood"'))).toBe('"my schema"."Mood"');
    expect(elementOf("integer")).toBeUndefined();
  });
});
