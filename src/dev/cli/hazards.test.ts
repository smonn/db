import { describe, expect, it } from "vitest";
import { hazardsIn } from "./hazards.ts";

describe("hazardsIn", () => {
  it("pairs each hazard comment with the statement under it", () => {
    const sql = [
      'create table "public"."a" (id int);',
      "",
      "-- hazard: data_loss",
      'drop table "public"."b";',
      "-- hazard: rewrite",
      "-- hazard: access_exclusive_lock",
      'alter table "public"."c"',
      "  alter column n type bigint;",
    ].join("\n");

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "data_loss", statement: 'drop table "public"."b";' },
      { kind: "rewrite", statement: 'alter table "public"."c" alter column n type bigint;' },
      {
        kind: "access_exclusive_lock",
        statement: 'alter table "public"."c" alter column n type bigint;',
      },
    ]);
  });

  it("finds none in a migration without hazard comments", () => {
    expect(hazardsIn("-- hazard lookalike\ncreate table a (n int);\n")).toStrictEqual([]);
  });
});
