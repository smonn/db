import { describe, expect, it } from "vitest";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
} from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./definition-catalog.ts";

describe("definitionCatalog domains", () => {
  it("has a domain fact keyed like a table, and one child fact per check", () => {
    const posint = defineDomain((c) => c.integer(), {
      notNull: true,
      default: "1",
      checks: { positive: "value > 0" },
    });
    const facts = Object.fromEntries(
      definitionCatalog(
        defineDatabase({
          public: { posint, t: defineTable((c) => ({ n: c.domain(posint).array() })) },
        }),
      ),
    );

    expect(facts["public\0posint"]).toStrictEqual({
      kind: "domain",
      name: "posint",
      parent: "public",
      payload: { base: "integer", notNull: true, default: "1", defaultVolatile: false },
    });
    expect(facts["public\0posint\0positive"]).toStrictEqual({
      kind: "domain check",
      name: "positive",
      parent: "public\0posint",
      payload: { expression: "value > 0" },
    });
    expect(facts["public\0t\0n"]).toMatchObject({
      payload: { type: "public.posint[]", notNull: false },
    });
  });

  it("spells the base as format_type does, an enum by its key", () => {
    const Mood = defineEnum(["a"]);
    const facts = Object.fromEntries(
      definitionCatalog(
        defineDatabase({
          app: {
            Mood,
            calm: defineDomain((c) => c.enum(Mood)),
            short: defineDomain((c) => c.varchar(20)),
          },
        }),
      ),
    );

    expect(facts["app\0calm"]).toMatchObject({ payload: { base: 'app."Mood"', default: null } });
    expect(facts["app\0short"]).toMatchObject({ payload: { base: "character varying(20)" } });
  });

  it("refuses a column or a domain whose type is not in the Definition, naming it", () => {
    const posint = defineDomain((c) => c.integer());
    const mood = defineEnum(["a"]);

    expect(() =>
      definitionCatalog(
        defineDatabase({ public: { t: defineTable((c) => ({ n: c.domain(posint) })) } }),
      ),
    ).toThrow(
      `Column "public"."t"."n" uses a domain that is not in the Definition; roll it up beside the tables in a schema`,
    );
    expect(() =>
      definitionCatalog(defineDatabase({ public: { calm: defineDomain((c) => c.enum(mood)) } })),
    ).toThrow(`Domain "public"."calm" uses an enum that is not in the Definition`);
  });

  it("refuses one domain rolled up under two names, naming both", () => {
    const posint = defineDomain((c) => c.integer());

    expect(() =>
      definitionCatalog(defineDatabase({ public: { posint }, app: { count: posint } })),
    ).toThrow(
      `One domain is rolled up as "public"."posint" and "app"."count"; give each its own defineDomain`,
    );
  });
});
