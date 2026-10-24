import { describe, expect, it } from "vitest";
import { parseMigration, writeMigration } from "../../runtime/internal/index.ts";
import {
  filesIn,
  memoryFileSystem,
  type MemoryFileSystem,
} from "./memory-file-system.test-helper.ts";
import { rebase } from "./rebase.ts";

const MIGRATIONS = "db/migrations";

const A = await writeMigration("000001-a.sql", undefined, "create table a (n int);");
const B = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
// Each moving file's new name is the old name of the next one.
const X2 = await writeMigration("000002-x.sql", A.hash, "create table x2 (n int);");
const X3 = await writeMigration("000003-x.sql", X2.hash, "create table x3 (n int);");
// After a gap, the last moving file takes the first one's old name.
const G4 = await writeMigration("000004-g.sql", A.hash, "create table g4 (n int);");
const H5 = await writeMigration("000005-h.sql", G4.hash, "create table h5 (n int);");
const G6 = await writeMigration("000006-g.sql", H5.hash, "create table g6 (n int);");

const later = { base: [A, B], files: [A, B, X2, X3] };
const earlier = { base: [A], files: [A, G4, H5, G6] };

/** Fails the `failAt`th write, counting from 1. */
function failingWrite(fileSystem: MemoryFileSystem, failAt: number): MemoryFileSystem {
  let writes = 0;
  return {
    ...fileSystem,
    writeFile: (path, content) => {
      writes += 1;
      if (writes === failAt) return Promise.reject(new Error("disk full"));
      return fileSystem.writeFile(path, content);
    },
  };
}

describe("rebase when a write fails partway", () => {
  it.each([
    { takes: "a later", failAt: 1, ...later },
    { takes: "a later", failAt: 2, ...later },
    { takes: "an earlier", failAt: 1, ...earlier },
    { takes: "an earlier", failAt: 2, ...earlier },
    { takes: "an earlier", failAt: 3, ...earlier },
  ])(
    "keeps every body when write $failAt fails and a file takes $takes file's old name",
    async ({ base, files, failAt }) => {
      const fileSystem = failingWrite(memoryFileSystem(filesIn(MIGRATIONS, files)), failAt);

      await expect(
        rebase({
          fileSystem,
          migrations: MIGRATIONS,
          base: { list: () => Promise.resolve(base) },
          onto: "origin/main",
        }),
      ).rejects.toThrow(
        `${MIGRATIONS} may be half-rewritten (disk full); restore it from git with git checkout -- ${MIGRATIONS}`,
      );
      const contents = [...fileSystem.files.values()].join("\n");
      for (const file of files) expect(contents).toContain(parseMigration(file).body);
    },
  );
});
