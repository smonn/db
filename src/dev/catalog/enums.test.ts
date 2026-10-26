import { describe, expect, it } from "vitest";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./catalog.ts";

const inApp =
  (...labels: string[]) =>
  () =>
    definitionCatalog(defineDatabase({ app: { mood: defineEnum(labels) } }));

const inPublic = (label: string) => () =>
  definitionCatalog(defineDatabase({ public: { mood: defineEnum([label]) } }));

describe("definitionCatalog enums", () => {
  it("has an enum fact under its schema, keyed by the enum's name, with its ordered labels", () => {
    const mood = defineEnum(["sad", "ok"]);
    const catalog = definitionCatalog(
      defineDatabase({ public: { users: defineTable((c) => ({ mood: c.enum(mood) })), mood } }),
    );

    expect(Object.fromEntries(catalog)["public\0mood"]).toStrictEqual({
      kind: "enum",
      name: "mood",
      parent: "public",
      payload: { labels: ["sad", "ok"] },
    });
    expect(Object.fromEntries(catalog)["public\0users\0mood"]).toMatchObject({
      payload: { type: "public.mood", notNull: false },
    });
  });

  it("names the column's type from the key, quoting what format_type quotes", () => {
    const Mood = defineEnum(["a"]);
    const catalog = definitionCatalog(
      defineDatabase({
        "my schema": { Mood, t: defineTable((c) => ({ x: c.enum(Mood) })) },
      }),
    );

    expect(Object.fromEntries(catalog)["my schema\0t\0x"]).toMatchObject({
      payload: { type: '"my schema"."Mood"' },
    });
  });

  it("allows an enum with no labels", () => {
    const catalog = definitionCatalog(defineDatabase({ public: { none: defineEnum([]) } }));

    expect(Object.fromEntries(catalog)["public\0none"]).toMatchObject({ payload: { labels: [] } });
  });

  it("refuses an empty, repeated, or over-long label, naming the enum", () => {
    expect(inApp("a", "")).toThrow(`Enum "app"."mood" has an empty label`);
    expect(inApp("a", "b", "a")).toThrow(`Enum "app"."mood" lists the label "a" twice`);
    expect(inApp("a".repeat(64))).toThrow(
      `Enum "app"."mood" has the label "${"a".repeat(64)}", which is over 63 bytes`,
    );
  });

  it("counts a label's bytes, not its characters", () => {
    expect(inPublic("é".repeat(31))).not.toThrow();
    expect(inPublic("é".repeat(32))).toThrow("over 63 bytes");
  });

  it("refuses a column whose enum is not in the Definition, naming the column", () => {
    const stray = defineEnum(["a"]);

    expect(() =>
      definitionCatalog(
        defineDatabase({ public: { t: defineTable((c) => ({ mood: c.enum(stray) })) } }),
      ),
    ).toThrow(`Column "public"."t"."mood" uses an enum that is not in the Definition`);
  });

  it("refuses one enum rolled up under two names, naming both", () => {
    const mood = defineEnum(["a"]);

    expect(() =>
      definitionCatalog(defineDatabase({ public: { mood }, app: { feeling: mood } })),
    ).toThrow(`One enum is rolled up as "public"."mood" and "app"."feeling"`);
  });
});
