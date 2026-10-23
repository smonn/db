import { describe, expect, it } from "vitest";
import { catalogBuilder } from "./catalog.ts";
import { payloadsEqual, qualified } from "./compare.ts";

describe("payloadsEqual", () => {
  it("ignores key order", () => {
    expect(payloadsEqual({ type: "text", notNull: true }, { notNull: true, type: "text" })).toBe(
      true,
    );
  });

  it("tells differing values, key sets, and non-objects apart", () => {
    expect(payloadsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(payloadsEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(payloadsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(payloadsEqual(null, {})).toBe(false);
    expect(payloadsEqual("a", "a")).toBe(true);
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
