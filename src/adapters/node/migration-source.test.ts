import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeMigrationSource } from "./migration-source.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smonn-db-migrations-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("nodeMigrationSource", () => {
  it("lists every .sql file in the folder, sorted by name", async () => {
    await writeFile(join(directory, "000002-b.sql"), "select 2;\r\n");
    await writeFile(join(directory, "000001-a.sql"), "select 'å';\n");

    expect(await nodeMigrationSource(directory).list()).toStrictEqual([
      { filename: "000001-a.sql", content: "select 'å';\n" },
      { filename: "000002-b.sql", content: "select 2;\r\n" },
    ]);
  });

  it("skips other files and folders", async () => {
    await writeFile(join(directory, "README.md"), "notes");
    await mkdir(join(directory, "000003-folder.sql"));

    expect(await nodeMigrationSource(directory).list()).toStrictEqual([]);
  });

  it("rejects when the folder is missing", async () => {
    await expect(nodeMigrationSource(join(directory, "missing")).list()).rejects.toThrow("ENOENT");
  });
});
