import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFileSystem } from "./file-system.ts";

let directory: string;
const fileSystem = nodeFileSystem();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smonn-db-file-system-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("nodeFileSystem", () => {
  it("reads a file as UTF-8", async () => {
    await writeFile(join(directory, "a.sql"), "select 'å';\n");

    expect(await fileSystem.readFile(`${directory}/a.sql`)).toBe("select 'å';\n");
  });

  it("reads a missing file as undefined", async () => {
    expect(await fileSystem.readFile(`${directory}/missing.sql`)).toBeUndefined();
  });

  it("rejects with the read error when a file can't be read", async () => {
    await writeFile(join(directory, "a.sql"), "select 1;\n", { mode: 0o000 });

    await expect(fileSystem.readFile(`${directory}/a.sql`)).rejects.toThrow("EACCES");
  });

  it("writes a file, replacing what it held", async () => {
    await writeFile(join(directory, "a.sql"), "select 1;\n");

    await fileSystem.writeFile(`${directory}/a.sql`, "select 'å';\n");

    expect(await readFile(join(directory, "a.sql"), "utf8")).toBe("select 'å';\n");
  });

  it("lists the files directly inside a directory, skipping folders", async () => {
    await writeFile(join(directory, "b.sql"), "");
    await writeFile(join(directory, "a.sql"), "");
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "c.sql"), "");

    expect((await fileSystem.list(directory)).toSorted()).toStrictEqual(["a.sql", "b.sql"]);
  });

  it("rejects listing a missing directory", async () => {
    await expect(fileSystem.list(`${directory}/missing`)).rejects.toMatchObject({
      message: `the folder ${directory}/missing doesn't exist`,
      cause: { code: "ENOENT" },
    });
  });

  it("creates a directory and its parents, and does nothing when it exists", async () => {
    await fileSystem.mkdir(`${directory}/db/migrations`);
    await fileSystem.mkdir(`${directory}/db/migrations`);

    expect(await fileSystem.list(`${directory}/db/migrations`)).toStrictEqual([]);
  });

  it("renames a file, replacing what the target held", async () => {
    await writeFile(join(directory, "a.sql.tmp"), "select 'å';\n");
    await writeFile(join(directory, "a.sql"), "select 1;\n");

    await fileSystem.rename(`${directory}/a.sql.tmp`, `${directory}/a.sql`);

    expect(await fileSystem.list(directory)).toStrictEqual(["a.sql"]);
    expect(await readFile(join(directory, "a.sql"), "utf8")).toBe("select 'å';\n");
  });

  it("removes a file, and does nothing when it is missing", async () => {
    await writeFile(join(directory, "a.sql"), "");

    await fileSystem.remove(`${directory}/a.sql`);
    await fileSystem.remove(`${directory}/a.sql`);

    expect(await fileSystem.list(directory)).toStrictEqual([]);
  });
});
