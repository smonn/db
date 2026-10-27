import { writeMigration } from "../../runtime/internal/index.ts";
import type { MigrationFile, MigrationSource } from "../../runtime/ports/index.ts";
import {
  filesIn,
  memoryFileSystem,
  type MemoryFileSystem,
} from "./memory-file-system.test-helper.ts";
import { rebase, type RebaseResult } from "./rebase.ts";

type Written = MigrationFile & { readonly hash: string };

export const MIGRATIONS = "db/migrations";
export const ONTO = "origin/main";

export const A: Written = await writeMigration(
  "000001-a.sql",
  undefined,
  "create table a (n int);",
);
export const B: Written = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
export const C: Written = await writeMigration("000003-c.sql", B.hash, "create table c (n int);");
// The branch's files, committed on A before B and C landed on the base.
export const X: Written = await writeMigration("000002-x.sql", A.hash, "create table x (n int);");
export const Y: Written = await writeMigration("000003-y.sql", X.hash, "create table y (n int);");

export function source(...files: MigrationFile[]): MigrationSource {
  return { list: () => Promise.resolve(files) };
}

export function folder(...files: MigrationFile[]): MemoryFileSystem {
  return memoryFileSystem(filesIn(MIGRATIONS, files));
}

export function rebaseFolder(
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
