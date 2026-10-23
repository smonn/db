import { describe, expect, it } from "vitest";
import { generateReport, resetReport } from "./report.ts";

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

describe("generateReport warnings", () => {
  it("prints the leftover difference as a warning", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          diff: "-select 1;\n",
          leftover: "the edit leaves a difference",
          reset: false,
          hazards: [],
        },
        "c.sql",
      ),
    ).toContain("warning: the edit leaves a difference");
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
