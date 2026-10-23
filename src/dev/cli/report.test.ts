import { describe, expect, it } from "vitest";
import { generateReport, hazardRefusal, resetReport } from "./report.ts";

describe("generateReport", () => {
  it("names the file, each Hazard with its statement, and the reset", () => {
    const sql = '-- hazard: data_loss\ndrop table "public"."a";\n';

    expect(
      generateReport({ path: "/p/current.sql", sql, reset: true, hazards: [] }, "current.sql"),
    ).toStrictEqual([
      "wrote current.sql",
      'hazard data_loss: drop table "public"."a";',
      "reset the Dev database",
    ]);
  });

  it("says when there was no diff and the Dev database stayed", () => {
    expect(
      generateReport(
        { path: "/p/current.sql", sql: undefined, reset: false, hazards: [] },
        "current.sql",
      ),
    ).toStrictEqual(["no diff, removed current.sql", "left the Dev database as it was"]);
  });

  it("says when a hand-edited file matches what generate would write", () => {
    expect(
      generateReport(
        { path: "/p/current.sql", sql: "select 1;", diff: "", reset: false, hazards: [] },
        "c.sql",
      ),
    ).toStrictEqual([
      "kept hand-edited c.sql, replayed as written; diff to what generate would write:",
      "matches what generate would write",
      "left the Dev database as it was",
    ]);
  });
});

describe("hazardRefusal", () => {
  const sql = [
    'create table "public"."a" (id int);',
    "-- hazard: data_loss",
    'drop table "public"."b";',
    "-- hazard: rewrite",
    "-- hazard: access_exclusive_lock",
    'alter table "public"."c"',
    "  alter column n type bigint;",
    "",
  ].join("\n");

  it("accepts a migration without hazard comments", () => {
    expect(hazardRefusal("create table a (n int);\n", [])).toBeUndefined();
  });

  it("accepts when every kind is named, including kinds the file doesn't use", () => {
    expect(hazardRefusal(sql, ["rewrite", "data_loss", "access_exclusive_lock"])).toBeUndefined();
  });

  it("groups the missing kinds by statement and prints one combined flag", () => {
    expect(hazardRefusal(sql, [])).toBe(
      [
        "current.sql has Hazards that --accept doesn't name:",
        '  data_loss: drop table "public"."b";',
        '  rewrite, access_exclusive_lock: alter table "public"."c" alter column n type bigint;',
        "to commit anyway, pass --accept data_loss,rewrite,access_exclusive_lock",
      ].join("\n"),
    );
  });

  it("lists only the kinds still missing, and the flag keeps the ones already named", () => {
    expect(hazardRefusal(sql, ["data_loss", "rewrite"])).toBe(
      [
        "current.sql has Hazards that --accept doesn't name:",
        '  access_exclusive_lock: alter table "public"."c" alter column n type bigint;',
        "to commit anyway, pass --accept data_loss,rewrite,access_exclusive_lock",
      ].join("\n"),
    );
  });
});

describe("resetReport", () => {
  it.each([
    [{ committed: 0, current: false }, "reset the Dev database from 0 Committed migrations"],
    [
      { committed: 1, current: true },
      "reset the Dev database from 1 Committed migration and current.sql",
    ],
  ])("words %j", (result, line) => {
    expect(resetReport(result)).toBe(line);
  });
});
