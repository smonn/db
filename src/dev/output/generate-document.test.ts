import { describe, expect, it } from "vitest";
import type { GenerateResult } from "../generate/index.ts";
import { generateDocument } from "./generate-document.ts";

const base: GenerateResult = {
  path: "/p/migrations/current.sql",
  sql: undefined,
  file: "absent",
  devDatabase: { kind: "none" },
  hazards: [],
  hints: [],
};

describe("generateDocument", () => {
  it.each(["written", "removed", "kept", "absent"] as const)(
    "names a generated file as %s, not hand-edited",
    (file) => {
      expect(generateDocument({ ...base, file }, "migrations/current.sql")).toStrictEqual({
        command: "generate",
        ok: true,
        file: { path: "migrations/current.sql", action: file, handEdited: false },
        hazards: [],
        hints: [],
        devDatabase: { kind: "none" },
      });
    },
  );

  it("reads the Hazards from the file's body, and passes the hints through", () => {
    const sql = '-- hazard: data_loss\ndrop table "public"."a";\n';

    const document = generateDocument(
      { ...base, sql, file: "written", hints: ["a rename hint"], hazards: [] },
      "current.sql",
    );

    expect(document.hazards).toStrictEqual([
      { kind: "data_loss", statement: 'drop table "public"."a";' },
    ]);
    expect(document.hints).toStrictEqual(["a rename hint"]);
  });

  it("reports the Hazards and hints of a run that changed nothing", () => {
    const sql = '-- hazard: rewrite\nalter table "public"."a" alter column "b" type bigint;\n';

    const document = generateDocument(
      { ...base, sql, file: "kept", hints: ["a rename hint"] },
      "current.sql",
    );

    expect(document.hazards).toHaveLength(1);
    expect(document.hints).toStrictEqual(["a rename hint"]);
  });

  it("holds a hand edit's diff and leftover", () => {
    const result: GenerateResult = {
      ...base,
      sql: "select 1;\n",
      file: "kept",
      diff: "-select 1;\n",
      leftover: "table is missing",
    };

    expect(generateDocument(result, "current.sql").file).toStrictEqual({
      path: "current.sql",
      action: "kept",
      handEdited: true,
      diff: "-select 1;\n",
      leftover: "table is missing",
    });
  });

  it("leaves out the leftover of a hand edit that has none, and keeps an empty diff", () => {
    const result: GenerateResult = { ...base, sql: "select 1;\n", file: "kept", diff: "" };

    expect(generateDocument(result, "current.sql").file).toStrictEqual({
      path: "current.sql",
      action: "kept",
      handEdited: true,
      diff: "",
    });
  });

  it.each([
    [{ kind: "reset" }],
    [
      {
        kind: "replayed",
        files: ["000001-a.sql", "current.sql"],
        hazards: [{ file: "000001-a.sql", kind: "data_loss", statement: "drop table a;" }],
      },
    ],
    [
      {
        kind: "diffed",
        skipped: ["000002-b.sql"],
        hazards: [{ kind: "rewrite", statement: "alter table a;" }],
      },
    ],
  ] as const)("holds the Dev database outcome %j as it is", (devDatabase) => {
    expect(generateDocument({ ...base, devDatabase }, "current.sql").devDatabase).toStrictEqual(
      devDatabase,
    );
  });
});
