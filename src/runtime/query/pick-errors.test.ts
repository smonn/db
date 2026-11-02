import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { from } from "./from.ts";

describe("pick errors", () => {
  it("quotes the rejected name, schema, and table", () => {
    const odd = defineDatabase({
      'my"schema': { 'Odd"Table': defineTable((c) => ({ id: c.integer() })) },
    });
    // @ts-expect-error the name is no column
    expect(() => from(odd['my"schema']['Odd"Table']).pick('bad"key')).toThrow(
      'pick: "bad""key" is not a column of "my""schema"."Odd""Table"',
    );
  });
});
