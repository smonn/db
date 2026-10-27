import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrationsFolder, loadProject } from "./project.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "smonn-db-project-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(): Promise<string> {
  const file = join(dir, "smonndb.config.ts");
  await writeFile(
    file,
    `export default { definition: "./definition.ts", migrations: "./migrations", url: "postgres://localhost/none" };\n`,
  );
  return file;
}

describe("loadProject", () => {
  it("resolves the migrations folder and loads the Definition against the config's folder", async () => {
    await writeFile(join(dir, "definition.ts"), `export default { public: {} };\n`);

    const project = await loadProject(await writeConfig());

    expect(project.migrationsFolder).toBe(join(dir, "migrations"));
    expect(await project.loadDefinition()).toStrictEqual({ public: {} });
  });

  it.each([
    ["null", "export default null;\n"],
    ["a string", `export default "definition";\n`],
    ["a number", "export default 5;\n"],
    ["a function", "export default () => ({});\n"],
    ["missing", "export const users = {};\n"],
  ])("refuses a Definition file whose default export is %s", async (_label, source) => {
    await writeFile(join(dir, "definition.ts"), source);
    const project = await loadProject(await writeConfig());

    await expect(project.loadDefinition()).rejects.toThrow(
      `${relative(process.cwd(), join(dir, "definition.ts"))} must export defineDatabase({ ... }) as its default export`,
    );
  });
});

describe("loadMigrationsFolder", () => {
  it("resolves the folder without needing a url", async () => {
    const file = join(dir, "smonndb.config.ts");
    await writeFile(
      file,
      `export default { definition: "./definition.ts", migrations: "./db/migrations", url: undefined };\n`,
    );

    expect(await loadMigrationsFolder(file)).toBe(join(dir, "db", "migrations"));
  });
});
