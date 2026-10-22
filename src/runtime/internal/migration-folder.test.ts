import { describe, expect, it } from "vitest";
import { readCommitted, type MigrationFolder } from "./migration-folder.ts";

function folder(files: Record<string, string>): MigrationFolder {
  return {
    list: () =>
      Promise.resolve(Object.keys(files).map((path) => path.slice(path.lastIndexOf("/") + 1))),
    readFile: (path) => Promise.resolve(files[path]),
  };
}

describe("readCommitted", () => {
  it.each(["db/migrations", "db/migrations/", "db/migrations//"])(
    "reads the files inside %s by a path with one separator",
    async (directory) => {
      expect(
        await readCommitted(folder({ "db/migrations/000001-a.sql": "select 1;\n" }), directory),
      ).toStrictEqual([{ filename: "000001-a.sql", content: "select 1;\n" }]);
    },
  );
});
