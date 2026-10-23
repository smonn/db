import { describe, expect, it } from "vitest";
import { catalogBuilder } from "./catalog.ts";
import { arePayloadsEqual, qualified } from "./compare.ts";

describe("arePayloadsEqual", () => {
  it("ignores key order", () => {
    expect(arePayloadsEqual({ type: "text", notNull: true }, { notNull: true, type: "text" })).toBe(
      true,
    );
  });

  it("tells differing values, key sets, and non-objects apart", () => {
    expect(arePayloadsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(arePayloadsEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(arePayloadsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(arePayloadsEqual(null, {})).toBe(false);
    expect(arePayloadsEqual("a", "a")).toBe(true);
  });
});

describe("qualified", () => {
  it("quotes and dots a fact's names", () => {
    const builder = catalogBuilder();
    builder.schema("Auth");
    builder.table("Auth", "users");
    const catalog = builder.build();
    expect([...catalog.values()].map((fact) => qualified(fact, catalog))).toStrictEqual([
      '"Auth"',
      '"Auth"."users"',
    ]);
  });
});
