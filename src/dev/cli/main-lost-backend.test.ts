import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  terminateBackendRunning,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { main } from "./main.ts";

const db = useTestDatabase();
const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

let project: string;
let stderr: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-cli-"));
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

// postgres.js's sql.end() never settles after a backend ended mid-statement (porsager/postgres#1226).
// That left bin.ts's top-level await pending, so Node exited 13 without printing the error.
it("exits 1 naming the error when the backend ends mid-migration", async () => {
  const url = new URL(String(process.env["DATABASE_URL"]));
  url.pathname = `/${db.name}`;
  const sleeping = await writeMigration("000001-sleep.sql", undefined, "select pg_sleep(30);\n");
  await mkdir(join(project, "migrations"));
  await writeFile(join(project, "migrations", sleeping.filename), sleeping.content);
  const config = join(project, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(url.href)} });\n`,
  );

  const [code] = await Promise.all([
    main(["migrate", "--config", config]),
    terminateBackendRunning(db.driver, "pg_sleep(30)"),
  ]);

  expect(code).toBe(1);
  expect(stderr).toMatch(/CONNECTION_CLOSED/u);
});
