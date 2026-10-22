import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeMigrationSource } from "./migration-source.ts";

// Deletes a file named 000001-vanishing.sql right after listing its folder, to stage the race.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: async (folder: string, options: { withFileTypes: true }) => {
      const entries = await fs.readdir(folder, options);
      await fs.rm(`${folder}/000001-vanishing.sql`, { force: true });
      return entries;
    },
  };
});

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

  it("skips the Current migration, which sits beside the Committed ones", async () => {
    await writeFile(join(directory, "000001-a.sql"), "select 1;\n");
    await writeFile(join(directory, "current.sql"), "select 2;\n");

    expect(await nodeMigrationSource(directory).list()).toStrictEqual([
      { filename: "000001-a.sql", content: "select 1;\n" },
    ]);
  });

  it("keeps a misnamed .sql file, so the migrator refuses it instead of skipping it", async () => {
    await writeFile(join(directory, "create-users.sql"), "select 1;\n");

    expect(await nodeMigrationSource(directory).list()).toStrictEqual([
      { filename: "create-users.sql", content: "select 1;\n" },
    ]);
  });

  it("skips other files and folders", async () => {
    await writeFile(join(directory, "README.md"), "notes");
    await mkdir(join(directory, "000003-folder.sql"));

    expect(await nodeMigrationSource(directory).list()).toStrictEqual([]);
  });

  it("refuses a file that vanishes between listing the folder and reading it", async () => {
    await writeFile(join(directory, "000001-vanishing.sql"), "select 1;\n");

    await expect(nodeMigrationSource(directory).list()).rejects.toThrow(
      `${directory}/000001-vanishing.sql vanished between listing and reading`,
    );
  });

  it("rejects with the read error when a file can't be read", async () => {
    await writeFile(join(directory, "000001-a.sql"), "select 1;\n", { mode: 0o000 });

    await expect(nodeMigrationSource(directory).list()).rejects.toThrow("EACCES");
  });

  it("rejects when the folder is missing", async () => {
    await expect(nodeMigrationSource(join(directory, "missing")).list()).rejects.toThrow("ENOENT");
  });
});
