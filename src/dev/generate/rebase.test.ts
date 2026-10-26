import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { readCommitted, writeMigration } from "../../runtime/internal/index.ts";
import { migrate, verify } from "../../runtime/migrator/index.ts";
import type { MigrationFile, MigrationSource } from "../../runtime/ports/index.ts";
import {
  filesIn,
  memoryFileSystem,
  type MemoryFileSystem,
} from "./memory-file-system.test-helper.ts";
import { rebase, type RebaseResult } from "./rebase.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const ONTO = "origin/main";

const A = await writeMigration("000001-a.sql", undefined, "create table a (n int);");
const B = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
const C = await writeMigration("000003-c.sql", B.hash, "create table c (n int);");
// The branch's files, committed on A before B and C landed on the base.
const X = await writeMigration("000002-x.sql", A.hash, "create table x (n int);");
const Y = await writeMigration("000003-y.sql", X.hash, "create table y (n int);");

function source(...files: MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

function folder(...files: MigrationFile[]): MemoryFileSystem {
  return memoryFileSystem(filesIn(MIGRATIONS, files));
}

function rebaseFolder(
  fileSystem: MemoryFileSystem,
  base: MigrationFile[],
  unheld: string[] = [],
): Promise<RebaseResult> {
  return rebase({
    fileSystem,
    migrations: MIGRATIONS,
    base: source(...base),
    onto: ONTO,
    unheld,
  });
}

describe("rebase", () => {
  it("moves the branch's files onto the base tip, rewriting their sequence and headers", async () => {
    const fileSystem = folder(A, B, C, X, Y);

    const result = await rebaseFolder(fileSystem, [A, B, C]);

    const X4 = await writeMigration("000004-x.sql", C.hash, "create table x (n int);");
    const Y5 = await writeMigration("000005-y.sql", X4.hash, "create table y (n int);");
    expect(result).toStrictEqual({
      moved: [
        { from: "000002-x.sql", to: "000004-x.sql" },
        { from: "000003-y.sql", to: "000005-y.sql" },
      ],
    });
    expect(Object.fromEntries(fileSystem.files)).toStrictEqual(
      filesIn(MIGRATIONS, [A, B, C, X4, Y5]),
    );
    const committed = await readCommitted(fileSystem, MIGRATIONS);
    expect((await verify(source(...committed))).verified).toHaveLength(5);
  });

  it("keeps a moving no-transaction file's header and rehashes over it (ADR-0020)", async () => {
    const index = "create index concurrently x_n on x (n);";
    const XI = await writeMigration("000003-xi.sql", X.hash, index, { noTransaction: true });
    const fileSystem = folder(A, B, C, X, XI);

    await rebaseFolder(fileSystem, [A, B, C]);

    const X4 = await writeMigration("000004-x.sql", C.hash, "create table x (n int);");
    const XI5 = await writeMigration("000005-xi.sql", X4.hash, index, { noTransaction: true });
    expect(Object.fromEntries(fileSystem.files)).toStrictEqual(
      filesIn(MIGRATIONS, [A, B, C, X4, XI5]),
    );
    expect(fileSystem.files.get(`${MIGRATIONS}/000005-xi.sql`)).toContain("\n--! no-transaction\n");
  });

  it("does nothing on a straight chain", async () => {
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    const fileSystem = folder(A, B, X3);
    const before = new Map(fileSystem.files);

    expect(await rebaseFolder(fileSystem, [A, B])).toStrictEqual({ moved: [] });
    expect(fileSystem.files).toStrictEqual(before);
  });

  it("does nothing when every file is in the base ref", async () => {
    const fileSystem = folder(A, B);

    expect(await rebaseFolder(fileSystem, [A, B])).toStrictEqual({ moved: [] });
  });

  it("does nothing on a second run", async () => {
    const fileSystem = folder(A, B, C, X, Y);
    await rebaseFolder(fileSystem, [A, B, C]);
    const after = new Map(fileSystem.files);

    expect(await rebaseFolder(fileSystem, [A, B, C])).toStrictEqual({ moved: [] });
    expect(fileSystem.files).toStrictEqual(after);
  });

  it("moves a branch file that starts the chain onto a base that gained files", async () => {
    const R = await writeMigration("000001-r.sql", undefined, "create table r (n int);");
    const fileSystem = folder(A, R);

    const result = await rebaseFolder(fileSystem, [A]);

    const R2 = await writeMigration("000002-r.sql", A.hash, "create table r (n int);");
    expect(result).toStrictEqual({ moved: [{ from: "000001-r.sql", to: "000002-r.sql" }] });
    expect(Object.fromEntries(fileSystem.files)).toStrictEqual(filesIn(MIGRATIONS, [A, R2]));
  });

  it("keeps a moving file's old name when another moving file takes it", async () => {
    const X3 = await writeMigration("000003-x.sql", X.hash, "create table x3 (n int);");
    const fileSystem = folder(A, B, X, X3);

    await rebaseFolder(fileSystem, [A, B]);

    const moved3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    const moved4 = await writeMigration("000004-x.sql", moved3.hash, "create table x3 (n int);");
    expect(Object.fromEntries(fileSystem.files)).toStrictEqual(
      filesIn(MIGRATIONS, [A, B, moved3, moved4]),
    );
  });

  it("rehashes a moving file whose sequence already follows the tip", async () => {
    const late = await writeMigration("000003-late.sql", A.hash, "create table late (n int);");
    const fileSystem = folder(A, B, late);

    const result = await rebaseFolder(fileSystem, [A, B]);

    const rehashed = await writeMigration("000003-late.sql", B.hash, "create table late (n int);");
    expect(result).toStrictEqual({ moved: [{ from: "000003-late.sql", to: "000003-late.sql" }] });
    expect(fileSystem.files.get(`${MIGRATIONS}/000003-late.sql`)).toBe(rehashed.content);
  });

  it("leaves current.sql alone", async () => {
    const fileSystem = folder(A, B, X);
    fileSystem.files.set(`${MIGRATIONS}/current.sql`, "select 1;\n");

    await rebaseFolder(fileSystem, [A, B]);

    expect(fileSystem.files.get(`${MIGRATIONS}/current.sql`)).toBe("select 1;\n");
  });

  it("refuses, writing nothing, naming each file git doesn't hold", async () => {
    const fileSystem = folder(A, B, X, Y);
    const before = new Map(fileSystem.files);

    await expect(
      rebaseFolder(fileSystem, [A, B], ["000002-x.sql", "000003-y.sql"]),
    ).rejects.toThrow(
      `${MIGRATIONS} has changes git doesn't hold: 000002-x.sql, 000003-y.sql; set them aside with git -C 'db/migrations' stash push --include-untracked -- . ':(exclude)current.sql', then rerun rebase`,
    );
    expect(fileSystem.files).toStrictEqual(before);
  });

  it("single-quotes the folder in the step it prints, escaping an embedded quote", async () => {
    await expect(
      rebase({
        fileSystem: memoryFileSystem({}),
        migrations: "my db/it's",
        base: source(),
        onto: ONTO,
        unheld: ["000002-x.sql"],
      }),
    ).rejects.toThrow(
      "git -C 'my db/it'\\''s' stash push --include-untracked -- . ':(exclude)current.sql', then rerun rebase",
    );
  });

  it("refuses on a leftover .sql.tmp", async () => {
    await expect(rebaseFolder(folder(A, B, X), [A, B], ["000003-x.sql.tmp"])).rejects.toThrow(
      `${MIGRATIONS} has changes git doesn't hold: 000003-x.sql.tmp;`,
    );
  });

  it("ignores paths rebase never reads or writes", async () => {
    const result = await rebaseFolder(
      folder(A, B, X),
      [A, B],
      [".DS_Store", "x.sql.swp", "sub/nested.sql", "sub/000009-z.sql.tmp", "README.md"],
    );

    expect(result).toStrictEqual({ moved: [{ from: "000002-x.sql", to: "000003-x.sql" }] });
  });

  it("moves files past a changed current.sql", async () => {
    const fileSystem = folder(A, B, X);

    const result = await rebaseFolder(fileSystem, [A, B], ["current.sql"]);

    expect(result).toStrictEqual({ moved: [{ from: "000002-x.sql", to: "000003-x.sql" }] });
  });

  it("refuses, naming the file, when a base file is missing from the folder", async () => {
    const fileSystem = folder(A, X);

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      `${ONTO} has 000002-b.sql, which ${MIGRATIONS} lacks; merge ${ONTO} first`,
    );
  });

  it("refuses to move a file whose name the base ref holds with other content", async () => {
    const edited = await writeMigration("000002-b.sql", A.hash, "create table b (m int);");
    const fileSystem = folder(A, edited);

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      `000002-b.sql: differs from its copy in ${ONTO}`,
    );
  });

  it("refuses to move a file whose body no longer matches its hash", async () => {
    const edited = { ...X, content: X.content.replace("(n int)", "(m int)") };
    const fileSystem = folder(A, B, edited);

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      /^000002-x\.sql: --! Hash says sha256:\w+ but the body hashes to sha256:\w+$/u,
    );
    expect(fileSystem.files.get(`${MIGRATIONS}/000002-x.sql`)).toBe(edited.content);
  });

  it("refuses to move a file that follows a hash the base ref lacks", async () => {
    const orphan = await writeMigration("000003-o.sql", C.hash, "create table o (n int);");
    const fileSystem = folder(A, B, orphan);

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      `000003-o.sql: follows ${C.hash}, which ${ONTO} lacks`,
    );
  });

  it("refuses moving files that don't chain onto each other", async () => {
    const fileSystem = folder(A, B, X, await writeMigration("000002-z.sql", A.hash, "select 1;"));

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      `000002-z.sql: --! Previous should be ${X.hash}, not ${A.hash}`,
    );
  });

  it("refuses a base ref whose chain is broken, naming the ref", async () => {
    const fileSystem = folder(A, C);

    await expect(rebaseFolder(fileSystem, [A, C])).rejects.toThrow(
      `${ONTO}: 000003-c.sql: sequence 2 is missing before it`,
    );
  });

  it("refuses, writing nothing, when the folder's chain would still be broken", async () => {
    const copy = { ...B, filename: "000002-b-copy.sql" };
    const fileSystem = folder(A, B, copy, X);
    const before = new Map(fileSystem.files);

    await expect(rebaseFolder(fileSystem, [A, B])).rejects.toThrow(
      "forked chain: 000002-b-copy.sql and 000002-b.sql both follow 000001-a.sql",
    );
    expect(fileSystem.files).toStrictEqual(before);
  });

  describe("with a Dev database that applied a moved file", () => {
    beforeEach(async () => {
      await db.driver.execute(
        "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
      );
    });

    it("fails migrate's prefix check afterward", async () => {
      await migrate({ driver: db.driver, source: source(A, X) });
      const fileSystem = folder(A, B, X);

      await rebaseFolder(fileSystem, [A, B]);

      const committed = await readCommitted(fileSystem, MIGRATIONS);
      await expect(migrate({ driver: db.driver, source: source(...committed) })).rejects.toThrow(
        `000002-b.sql: stands where the recorded 000002-x.sql (${X.hash}) was`,
      );
    });
  });
});
