import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { createClient, from, insert } from "../../runtime/query/index.ts";
import { main } from "./main.ts";

const dev = useTestDatabase();
const production = useTestDatabase();

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

const db = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
});

const DEFINITION = `import { defineDatabase, defineTable } from "${source("../../runtime/definition/index.ts")}";

export default defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
});
`;

const config = (
  variable: string,
): string => `import { defineConfig } from "${source("../config/index.ts")}";

export default defineConfig({
  definition: "./db/definition.ts",
  migrations: "./db/migrations",
  url: process.env.${variable},
});
`;

function urlOf(name: string): string {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.pathname = `/${name}`;
  return url.href;
}

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-cli-"));
  await mkdir(join(project, "db"));
  await writeFile(join(project, "db", "definition.ts"), DEFINITION);
  await writeFile(join(project, "dev.config.ts"), config("SMONNDB_TEST_DEV_URL"));
  await writeFile(join(project, "production.config.ts"), config("SMONNDB_TEST_PRODUCTION_URL"));
  vi.stubEnv("SMONNDB_TEST_DEV_URL", urlOf(dev.name));
  vi.stubEnv("SMONNDB_TEST_PRODUCTION_URL", urlOf(production.name));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

describe("smonndb", () => {
  it("generates, commits, and migrates a Definition into a second database", async () => {
    const devConfig = join(project, "dev.config.ts");

    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(0);
    expect(await main(["migrate", "--config", join(project, "production.config.ts")])).toBe(0);

    expect(await readdir(join(project, "db", "migrations"))).toStrictEqual([
      "000001-create-users.sql",
    ]);
    const client = createClient(production.driver);
    await client.run(insert(db.public.users).values({ id: "u1", email: "a@example.com" }));
    expect(await client.all(from(db.public.users))).toStrictEqual([
      { id: "u1", email: "a@example.com" },
    ]);
  });

  it("resets a Dev database, and a migrated one only with --erase", async () => {
    const devConfig = join(project, "dev.config.ts");
    const productionConfig = join(project, "production.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(0);
    expect(await main(["migrate", "--config", productionConfig])).toBe(0);
    await dev.driver.execute("create table public.stray (id int)");

    expect(await main(["reset", "--config", devConfig])).toBe(0);

    const strays = await dev.driver.query("select to_regclass('public.stray') as name");
    expect(strays.rows).toStrictEqual([{ name: null }]);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["reset", "--config", productionConfig])).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("isn't a Dev database");
    expect(await main(["reset", "--erase", "--config", productionConfig])).toBe(0);
  });

  it("runs from its bin under plain node, resolving the config's paths against its folder", async () => {
    const stdout = execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "bin.ts"),
        "generate",
        "--config",
        join(basename(project), "dev.config.ts"),
      ],
      { cwd: dirname(project), encoding: "utf8" },
    );

    expect(stdout).toBe(`wrote ${join(basename(project), "db", "migrations", "current.sql")}\n`);
    expect(await readFile(join(project, "db", "migrations", "current.sql"), "utf8")).toContain(
      `create table "public"."users"`,
    );
  });
});
