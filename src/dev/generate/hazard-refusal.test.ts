import { describe, expect, it } from "vitest";
import { hazardRefusal } from "./hazard-refusal.ts";

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

describe("hazardRefusal", () => {
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

  it("names an unknown kind apart from the flag, which can't accept it", () => {
    const typo = `${sql}-- hazard: dataloss\n-- hazard: dataloss\ndrop table "public"."d";\n`;

    expect(hazardRefusal(typo, ["data_loss", "rewrite"])).toBe(
      [
        "current.sql has Hazards that --accept doesn't name:",
        '  access_exclusive_lock: alter table "public"."c" alter column n type bigint;',
        'unknown Hazard kind "dataloss" in current.sql; fix or delete the comment',
        "to commit anyway, pass --accept data_loss,rewrite,access_exclusive_lock",
      ].join("\n"),
    );
  });

  it("refuses an unknown kind alone without a flag line", () => {
    expect(hazardRefusal('-- hazard: dataloss\ndrop table "public"."d";\n', ["data_loss"])).toBe(
      'unknown Hazard kind "dataloss" in current.sql; fix or delete the comment',
    );
  });
});
