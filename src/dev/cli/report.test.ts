import { describe, expect, it } from "vitest";
import { generateReport, resetReport } from "./report.ts";

describe("generateReport", () => {
  it("names the file, each Hazard with its statement, and the reset", () => {
    const sql = '-- hazard: data_loss\ndrop table "public"."a";\n';

    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql,
          file: "written",
          devDatabase: { kind: "reset" },
          hazards: [],
          hints: [],
        },
        "current.sql",
      ),
    ).toStrictEqual([
      "wrote current.sql",
      'hazard data_loss: drop table "public"."a";',
      "reset the Dev database",
    ]);
  });

  it("says when there was no diff, and nothing of a Dev database that stayed", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: undefined,
          file: "removed",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: [],
        },
        "current.sql",
      ),
    ).toStrictEqual(["no diff, removed current.sql"]);
  });

  it("prints nothing when the file and the Dev database stayed as they were", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "kept",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: [],
        },
        "current.sql",
      ),
    ).toStrictEqual([]);
  });

  it("prints no Hazard or hint again for a generated file it kept as it was", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: '-- hazard: data_loss\ndrop table "public"."a";\n',
          file: "kept",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: ['table "a" may be a rename of "b"'],
        },
        "current.sql",
      ),
    ).toStrictEqual([]);
  });

  it("says when a hand-edited file matches what generate would write", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "kept",
          diff: "",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: [],
        },
        "c.sql",
      ),
    ).toStrictEqual([
      "kept hand-edited c.sql, replayed as written; diff to what generate would write:",
      "matches what generate would write",
    ]);
  });
});

describe("generateReport replays", () => {
  it("names the replayed files on one line, then each Hazard they applied", () => {
    const drop = 'alter table "public"."a" drop column "b";';

    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "written",
          devDatabase: {
            kind: "replayed",
            files: ["000002-drop-b.sql", "current.sql"],
            hazards: [{ file: "000002-drop-b.sql", kind: "data_loss", statement: drop }],
          },
          hazards: [],
          hints: [],
        },
        "c.sql",
      ),
    ).toStrictEqual([
      "wrote c.sql",
      "replayed 000002-drop-b.sql, current.sql into the Dev database",
      `hazard data_loss in 000002-drop-b.sql: ${drop}`,
    ]);
  });
});

describe("generateReport hints", () => {
  it("prints each hint after the Hazards and before the reset", () => {
    const hints = ['table "a" may be a rename of "b"'];

    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "written",
          devDatabase: { kind: "none" },
          hazards: [],
          hints,
        },
        "c.sql",
      ),
    ).toStrictEqual(["wrote c.sql", `hint: ${hints[0]}`]);
  });
});

describe("generateReport warnings", () => {
  it("prints the leftover difference as a warning", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "kept",
          diff: "-select 1;\n",
          leftover: "the edit leaves a difference",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: [],
        },
        "c.sql",
      ),
    ).toContain("warning: the edit leaves a difference");
  });

  it("prints the diff without its trailing newline", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: "select 1;",
          file: "kept",
          diff: "-select 1;\n+select 2;\n",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: [],
        },
        "c.sql",
      ),
    ).toStrictEqual([
      "kept hand-edited c.sql, replayed as written; diff to what generate would write:",
      "-select 1;\n+select 2;",
    ]);
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
