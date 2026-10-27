import { describe, expect, it } from "vitest";
import { hazardsIn, strayHazardComments } from "./hazards.ts";

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

  it("pairs back-to-back hazards in separate statements, and one cut off at the end", () => {
    const sql = [
      "-- hazard: data_loss",
      "drop table a;",
      "-- hazard: rewrite",
      "alter table b",
    ].join("\n");

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "data_loss", statement: "drop table a;" },
      { kind: "rewrite", statement: "alter table b" },
    ]);
  });

  it("reads a hazard comment inside a statement as part of that statement", () => {
    const sql = ["-- hazard: a", "alter table x", "-- hazard: b", "  drop column y;"].join("\n");

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "a", statement: "alter table x -- hazard: b drop column y;" },
    ]);
  });

  it("starts the statement at the first line after the hazards, even a blank or comment line", () => {
    const sql = ["-- hazard: a", "", "-- note", "drop table t;"].join("\n");

    const found = hazardsIn(sql);

    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("a");
    expect(found[0]?.statement.trim()).toBe("-- note drop table t;");
  });

  it("finds none in a migration without hazard comments", () => {
    expect(hazardsIn("-- hazard lookalike\ncreate table a (n int);\n")).toStrictEqual([]);
  });
});

describe("strayHazardComments", () => {
  it.each([
    ["indented", "  -- hazard: data_loss"],
    ["unspaced", "--hazard: data_loss"],
    ["recased", "-- Hazard: data_loss"],
    ["triple dash", "--- hazard: data_loss"],
    ["spaced colon", "-- hazard : data_loss"],
  ])("flags a %s comment above a statement", (_name, comment) => {
    const sql = `${comment}\ndrop table a;\n`;

    expect(strayHazardComments(sql)).toStrictEqual([{ line: 1, text: comment }]);
    expect(hazardsIn(sql)).toStrictEqual([]);
  });

  it("flags a comment trailing a statement", () => {
    const sql = "create table a (n int); -- hazard: data_loss\n";

    expect(strayHazardComments(sql)).toStrictEqual([{ line: 1, text: sql.trimEnd() }]);
  });

  it("flags an exact comment inside a multi-line statement, with its line number", () => {
    const sql = ["-- hazard: a", "alter table x", "-- hazard: b", "  drop column y;"].join("\n");

    expect(strayHazardComments(sql)).toStrictEqual([{ line: 3, text: "-- hazard: b" }]);
  });

  it("flags an exact comment with no statement under it", () => {
    expect(strayHazardComments("create table a (n int);\n-- hazard: data_loss\n")).toStrictEqual([
      { line: 2, text: "-- hazard: data_loss" },
    ]);
  });

  it("flags an exact comment inside a multi-line statement that has no Hazard above it", () => {
    const sql = "CREATE TABLE t (\n-- hazard: data_loss\na int\n);\n";

    expect(strayHazardComments(sql)).toStrictEqual([{ line: 2, text: "-- hazard: data_loss" }]);
    expect(hazardsIn(sql)).toStrictEqual([]);
  });

  it("flags an exact comment between the clauses of an ALTER with no Hazard above it", () => {
    const sql = "ALTER TABLE t\nADD c int,\n-- hazard: rewrite\nDROP COLUMN d;\n";

    expect(strayHazardComments(sql)).toStrictEqual([{ line: 3, text: "-- hazard: rewrite" }]);
    expect(hazardsIn(sql)).toStrictEqual([]);
  });

  it("gives an unpaired comment no Hazard", () => {
    expect(hazardsIn("create table a (n int);\n-- hazard: data_loss\n")).toStrictEqual([]);
  });

  it("ends a statement at a semicolon followed by a comment", () => {
    const sql = "-- hazard: data_loss\nDROP TABLE t; -- ok\n-- hazard: rewrite\nDROP TABLE u;\n";

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "data_loss", statement: "DROP TABLE t; -- ok" },
      { kind: "rewrite", statement: "DROP TABLE u;" },
    ]);
    expect(strayHazardComments(sql)).toStrictEqual([]);
  });

  it("ends a statement at a semicolon followed by a comment on a CRLF line", () => {
    const sql =
      "-- hazard: data_loss\r\nDROP TABLE t; -- ok\r\n-- hazard: rewrite\r\nDROP TABLE u;\r\n";

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "data_loss", statement: "DROP TABLE t; -- ok" },
      { kind: "rewrite", statement: "DROP TABLE u;" },
    ]);
  });

  it("doesn't end a statement at a semicolon inside a trailing comment", () => {
    const sql = "-- hazard: data_loss\nDROP TABLE t -- gone;\n;\nSELECT 1;\n";

    expect(hazardsIn(sql)).toStrictEqual([
      { kind: "data_loss", statement: "DROP TABLE t -- gone; ;" },
    ]);
  });

  it("still flags a Hazard comment trailing the semicolon", () => {
    const sql = "DROP TABLE t; -- hazard: data_loss\n-- hazard: rewrite\nDROP TABLE u;\n";

    expect(strayHazardComments(sql)).toStrictEqual([
      { line: 1, text: "DROP TABLE t; -- hazard: data_loss" },
    ]);
    expect(hazardsIn(sql)).toStrictEqual([{ kind: "rewrite", statement: "DROP TABLE u;" }]);
  });

  it("lists strays in line order, whether found in a statement or left unpaired", () => {
    const sql = "-- hazard: rewrite\n\n  -- hazard: data_loss\n\n--hazard: share_lock\n";

    expect(strayHazardComments(sql)).toStrictEqual([
      { line: 1, text: "-- hazard: rewrite" },
      { line: 3, text: "  -- hazard: data_loss" },
      { line: 5, text: "--hazard: share_lock" },
    ]);
  });

  it("reads a Hazard comment only when nothing follows its kind but spaces", () => {
    expect(hazardsIn("-- hazard: data_loss  \ndrop table a;\n")).toStrictEqual([
      { kind: "data_loss", statement: "drop table a;" },
    ]);
    const sql = "-- hazard: data_loss extra\ndrop table a;\n";
    expect(hazardsIn(sql)).toStrictEqual([]);
    expect(strayHazardComments(sql)).toStrictEqual([
      { line: 1, text: "-- hazard: data_loss extra" },
    ]);
  });

  it("ignores paired comments, plural prose, block comments, and a hazards table", () => {
    const sql = [
      "-- hazard: data_loss",
      "drop table a;",
      "-- hazards: see the docs",
      "/* hazard: data_loss */",
      "create table hazards (hazard text);",
    ].join("\n");

    expect(strayHazardComments(sql)).toStrictEqual([]);
  });
});
