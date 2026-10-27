import { describe, expect, it } from "vitest";
import { defineDomain, defineEnum, defineTable } from "../definition/index.ts";
import { elementSqlType, isTextArray } from "./array-text.ts";

const shade = defineEnum(["light", "dark"] as const);
const money = defineDomain((c) => c.numeric(12, 2));
const { columns } = defineTable((c) => ({
  plain: c.integer(),
  ints: c.integer().array(),
  label: c.varchar(50),
  amount: c.numeric(10, 2),
  shade: c.enum(shade),
  shades: c.enum(shade).array(),
  money: c.domain(money),
  monies: c.domain(money).array(),
}));

describe("elementSqlType", () => {
  it("drops the length or precision of a column's type", () => {
    expect(elementSqlType(columns.plain)).toBe("integer");
    expect(elementSqlType(columns.label)).toBe("varchar");
    expect(elementSqlType(columns.amount)).toBe("numeric");
  });

  it("takes the base type of a domain", () => {
    expect(elementSqlType(columns.monies)).toBe("numeric");
  });
});

describe("isTextArray", () => {
  it("is true for an enum or domain array", () => {
    expect(isTextArray(columns.shades)).toBe(true);
    expect(isTextArray(columns.monies)).toBe(true);
  });

  it("is false for any other column", () => {
    expect(isTextArray(columns.plain)).toBe(false);
    expect(isTextArray(columns.ints)).toBe(false);
    expect(isTextArray(columns.shade)).toBe(false);
    expect(isTextArray(columns.money)).toBe(false);
  });
});
