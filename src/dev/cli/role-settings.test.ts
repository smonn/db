import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testServerUrl,
  useTestDatabase,
} from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { main } from "./main.ts";

const dev = useTestDatabase();

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

/** A project whose only Committed migration creates a SQL function over a missing table. */
async function countingMissingTable(url: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "smonn-db-role-settings-"));
  await mkdir(join(project, "db", "migrations"), { recursive: true });
  await writeFile(
    join(project, "db", "definition.ts"),
    `import { defineDatabase } from "${source("../../runtime/definition/index.ts")}";\n\nexport default defineDatabase({ public: {} });\n`,
  );
  await writeFile(
    join(project, "smonndb.config.ts"),
    `import { defineConfig } from "${source("../config/index.ts")}";

export default defineConfig({
  definition: "./db/definition.ts",
  migrations: "./db/migrations",
  url: ${JSON.stringify(url)},
});
`,
  );
  const count = await writeMigration(
    "000001-count.sql",
    undefined,
    "create function public.total() returns bigint language sql as 'select count(*) from public.missing';\n",
  );
  await writeFile(join(project, "db", "migrations", count.filename), count.content);
  return project;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("smonndb generate as a role with its own settings", () => {
  it("replays in the Shadow with check_function_bodies on when the role turns it off", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const role = `smonn_db_unchecked_${suffix}`;
    await dev.driver.execute(
      `create role ${role} login createdb password '${suffix}'; alter role ${role} set check_function_bodies = off;`,
    );
    const url = new URL(testServerUrl());
    url.username = role;
    url.password = suffix;
    url.pathname = `/${dev.name}`;
    const project = await countingMissingTable(url.href);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["generate", "--config", join(project, "smonndb.config.ts")])).toBe(1);
      expect(errors).toHaveBeenCalledWith(`relation "public.missing" does not exist\n`);
    } finally {
      await dev.driver.execute(`drop owned by ${role}; drop role ${role};`);
      await rm(project, { recursive: true, force: true });
    }
  });
});
