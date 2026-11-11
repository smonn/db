import { expect, it } from "vitest";
import { ChainBrokenError, writeMigration } from "../../runtime/internal/index.ts";
import { A, B, C, folder, rebaseFolder, X } from "./rebase.test-helper.ts";

it("throws a ChainBrokenError for each way the moving files or the base ref's chain break", async () => {
  const edited = { ...X, content: X.content.replace("(n int)", "(m int)") };
  const orphan = await writeMigration("000003-o.sql", C.hash, "create table o (n int);");
  const stray = await writeMigration("000002-z.sql", A.hash, "select 1;");
  const cases = [
    { files: [A, B, edited], base: [A, B] },
    { files: [A, B, orphan], base: [A, B] },
    { files: [A, B, X, stray], base: [A, B] },
    { files: [A, C], base: [A, C] },
  ];

  for (const { files, base } of cases) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each case is independent and cheap.
    await expect(rebaseFolder(folder(...files), base)).rejects.toBeInstanceOf(ChainBrokenError);
  }
});
