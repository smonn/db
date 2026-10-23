import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  terminateBackendRunning,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const db = useTestDatabase();
const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

const cli = useCliProject();

// postgres.js's sql.end() never settles after a backend ended mid-statement (porsager/postgres#1226).
// That left bin.ts's top-level await pending, so Node exited 13 without printing the error.
it("exits 1 naming the error when the backend ends mid-migration", async () => {
  const url = new URL(String(process.env["DATABASE_URL"]));
  url.pathname = `/${db.name}`;
  const sleeping = await writeMigration("000001-sleep.sql", undefined, "select pg_sleep(30);\n");
  await mkdir(join(cli.dir, "migrations"));
  await writeFile(join(cli.dir, "migrations", sleeping.filename), sleeping.content);
  const config = join(cli.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(url.href)} });\n`,
  );

  const [code] = await Promise.all([
    main(["migrate", "--config", config]),
    terminateBackendRunning(db.driver, "pg_sleep(30)"),
  ]);

  expect(code).toBe(1);
  expect(cli.stderr).toMatch(/CONNECTION_CLOSED/u);
});
