import { describe, expect, it } from "vitest";
import { quoteIdentifier } from "./quote-identifier.ts";

describe("quoteIdentifier", () => {
  it("wraps a name in double quotes", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
  });

  it('doubles an embedded "', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});
