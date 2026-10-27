import { describe, expect, it } from "vitest";
import { keyColumns } from "./table-keys.ts";

describe("keyColumns", () => {
  it("lists no column for an index whose columns are not a list", () => {
    expect(keyColumns({}, undefined, "indexes")).toStrictEqual([]);
    expect(keyColumns({}, "a", "indexes")).toStrictEqual([]);
  });

  it("refuses a unique or primary key whose columns are not a list", () => {
    expect(() => keyColumns({}, undefined, "unique")).toThrow(
      "The table's unique lists fewer than two columns; call unique() on the column instead",
    );
  });
});
