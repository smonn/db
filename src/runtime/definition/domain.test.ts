import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineDomain, defineEnum, defineTable, type Row } from "./index.ts";
import { isDomain } from "./domain.ts";
import { isEnum } from "./enum.ts";

describe("defineDomain", () => {
  it("keeps its base, NOT NULL, default, and checks keyed by name", () => {
    const posint = defineDomain((c) => c.integer(), {
      notNull: true,
      default: "1",
      checks: { positive: "value > 0" },
    });

    expect(posint).toMatchObject({
      kind: "domain",
      base: { sqlType: "integer", enumType: undefined },
      notNull: true,
      default: "1",
      checks: { positive: "value > 0" },
    });
  });

  it("defaults to a nullable domain with no default or checks", () => {
    expect(defineDomain((c) => c.text())).toMatchObject({
      notNull: false,
      default: undefined,
      checks: {},
    });
  });

  it("takes an enum as its base", () => {
    const mood = defineEnum(["sad", "ok"]);
    const calm = defineDomain((c) => c.enum(mood));

    expect(calm.base).toStrictEqual({ sqlType: "", enumType: mood });
    expectTypeOf<(typeof calm)["~types"]["value"]>().toEqualTypeOf<"sad" | "ok">();
  });

  it("refuses an array base, at compile time and at run time", () => {
    expect(() =>
      // @ts-expect-error -- an array is no domain base.
      defineDomain((c) => c.integer().array()),
    ).toThrow(
      "A domain's base can't be an array; make each column an array instead, as in c.domain(posint).array()",
    );
  });

  it("refuses another domain as its base", () => {
    const posint = defineDomain((c) => c.integer());
    expect(() =>
      // @ts-expect-error -- the base factories have no domain, but plain JS can still reach one.
      // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-call -- the missing method is the point.
      defineDomain((c) => c.domain(posint)),
    ).toThrow("A domain's base can't be another domain");
  });

  it("refuses a modified base, since notNull, default, and checks go in its options", () => {
    expect(() =>
      // @ts-expect-error -- a NOT NULL column is no bare type.
      defineDomain((c) => c.integer().notNull()),
    ).toThrow("defineDomain takes a bare type");
    expect(() => defineDomain((c) => c.integer().index())).toThrow(
      "defineDomain takes a bare type, such as c.integer(); declare notNull, default, and checks in its options",
    );
    expect(() => defineDomain((c) => c.integer().name("whole"))).toThrow(
      "defineDomain takes a bare type",
    );
    expect(() => defineDomain((c) => c.integer().renamedFrom("whole"))).toThrow(
      "defineDomain takes a bare type",
    );
    expect(() =>
      // @ts-expect-error -- a default belongs in the domain's options.
      defineDomain((c) => c.integer().default("0")),
    ).toThrow("defineDomain takes a bare type");
    expect(() =>
      // @ts-expect-error -- an identity is no bare type.
      defineDomain((c) => c.integer().identity()),
    ).toThrow("defineDomain takes a bare type");
    const target = defineTable((c) => ({ id: c.integer().primaryKey() }));
    expect(() =>
      // @ts-expect-error -- a reference belongs on a table's column.
      defineDomain((c) => c.integer().references(() => target.columns.id)),
    ).toThrow("defineDomain takes a bare type");
    expect(() =>
      // @ts-expect-error -- a codec belongs on the domain's columns.
      defineDomain((c) => c.integer().codec({ decode: String, encode: Number })),
    ).toThrow("defineDomain takes a bare type");
  });
});

describe("isDomain and isEnum", () => {
  const domain = defineDomain((c) => c.integer());
  const mood = defineEnum(["ok"]);

  it("tell a domain from an enum and from anything else", () => {
    expect([isDomain(domain), isDomain(mood)]).toStrictEqual([true, false]);
    expect([isEnum(mood), isEnum(domain)]).toStrictEqual([true, false]);
    for (const other of [null, undefined, 3, "domain", "enum", {}, { kind: "table" }]) {
      expect([isDomain(other), isEnum(other)]).toStrictEqual([false, false]);
    }
  });
});

describe("c.domain", () => {
  it("types a column as its base's value, non-null when the domain is NOT NULL", () => {
    const mood = defineEnum(["sad", "ok"]);
    const posint = defineDomain((c) => c.integer(), { notNull: true });
    const label = defineDomain((c) => c.text<"a" | "b">());
    const calm = defineDomain((c) => c.enum(mood));
    const t = defineTable((c) => ({
      count: c.domain(posint),
      label: c.domain(label),
      required: c.domain(label).notNull(),
      calm: c.domain(calm),
      counts: c.domain(posint).array(),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      count: number;
      label: "a" | "b" | null;
      required: "a" | "b";
      calm: "sad" | "ok" | null;
      counts: (number | null)[] | null;
    }>();
  });

  it("holds the domain itself, leaving the column's own NOT NULL alone", () => {
    const posint = defineDomain((c) => c.integer(), { notNull: true });
    const t = defineTable((c) => ({ count: c.domain(posint) }));

    expect(t.columns.count.state).toMatchObject({
      sqlType: "",
      enumType: undefined,
      domainType: posint,
      notNull: false,
    });
  });

  it("sits in a schema beside its tables and comes back as the same value", () => {
    const posint = defineDomain((c) => c.integer());
    const t = defineTable((c) => ({ count: c.domain(posint) }));
    const database = defineDatabase({ public: { posint, t } });

    expect(database.public.posint).toBe(posint);
    expect(database.public.t).toMatchObject({ schema: "public", name: "t" });
  });
});
