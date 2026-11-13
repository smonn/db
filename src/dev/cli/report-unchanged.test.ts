import { describe, expect, it } from "vitest";
import { generateReport } from "./report.ts";

describe("generateReport on a run that changed nothing", () => {
  it("prints nothing for a run with no diff and no file to remove, hints included", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: undefined,
          file: "absent",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: ['table "a" may be a rename of "b"'],
        },
        "current.sql",
      ),
    ).toStrictEqual([]);
  });

  it("prints the Hazards and hints of a hand edit, though the file stays as it was", () => {
    expect(
      generateReport(
        {
          path: "/p/current.sql",
          sql: '-- hazard: data_loss\ndrop table "public"."a";\n',
          file: "kept",
          diff: "-a\n+b\n",
          devDatabase: { kind: "none" },
          hazards: [],
          hints: ['table "a" may be a rename of "b"'],
        },
        "current.sql",
      ),
    ).toStrictEqual([
      "kept hand-edited current.sql, replayed as written; diff to what generate would write:",
      "-a\n+b",
      'hazard data_loss: drop table "public"."a";',
      'hint: table "a" may be a rename of "b"',
    ]);
  });
});
