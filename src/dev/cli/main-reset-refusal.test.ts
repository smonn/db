import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const db = useTestDatabase();
const project = useCliProject();
const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;
const definitionUrl = pathToFileURL(
  join(import.meta.dirname, "../../runtime/definition/index.ts"),
).href;

it("exits 1 naming the tampered file, and leaves the Dev tables alone", async () => {
  const first = await writeMigration("000001-a.sql", undefined, "create table a (n int);\n");
  await mkdir(join(project.dir, "migrations"));
  await writeFile(join(project.dir, "migrations", first.filename), `${first.content}\nselect 1;\n`);
  await writeFile(
    join(project.dir, "definition.ts"),
    `import { defineDatabase } from "${definitionUrl}";\n\nexport default defineDatabase({});\n`,
  );
  const config = join(project.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(db.url)} });\n`,
  );
  await db.driver.execute(
    "drop table if exists cli_reset_junk; create table cli_reset_junk (n int)",
  );

  const code = await main(["reset", "--erase", "--config", config]);

  expect(code).toBe(1);
  expect(project.stderr).toMatch(/^000001-a\.sql: --! Hash says /u);
  const { rows } = await db.driver.query(
    "select table_name from information_schema.tables where table_name = 'cli_reset_junk'",
  );
  expect(rows).toStrictEqual([{ table_name: "cli_reset_junk" }]);
});
