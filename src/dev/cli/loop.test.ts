import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

function signalListeners(): number[] {
  return [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
}

let project: string;
function stdoutOf(): string {
  return written.mock.calls.map(([chunk]) => String(chunk)).join("");
}

let written: { mock: { calls: unknown[][] }; mockClear: () => unknown };

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "smonn-db-cli-"));
  await mkdir(join(project, "db"));
  await writeFile(join(project, "db", "definition.ts"), DEFINITION);
  await writeFile(join(project, "dev.config.ts"), config("SMONNDB_TEST_DEV_URL"));
  await writeFile(join(project, "production.config.ts"), config("SMONNDB_TEST_PRODUCTION_URL"));
  vi.stubEnv("SMONNDB_TEST_DEV_URL", urlOf(dev.name));
  vi.stubEnv("SMONNDB_TEST_PRODUCTION_URL", urlOf(production.name));
  written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

describe("smonndb", () => {
  it("keeps a hand-edited current.sql and prints the diff to what generate would write", async () => {
    const devConfig = join(project, "dev.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    const file = join(project, "db", "migrations", "current.sql");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}-- hazard: data_loss\ndrop table "public"."users";\n`,
    );
    written.mockClear();

    expect(await main(["generate", "--config", devConfig])).toBe(0);

    expect(await readFile(file, "utf8")).toContain('drop table "public"."users";\n');
    const output = stdoutOf();
    expect(output).toContain(`kept hand-edited ${relative(process.cwd(), file)}`);
    expect(output).toContain("\n-drop table");
    expect(output).toContain('hazard data_loss: drop table "public"."users";\n');
  });

  it("commits a hand-edited Hazard only once --accept names its kind", async () => {
    const devConfig = join(project, "dev.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    const file = join(project, "db", "migrations", "current.sql");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}-- hazard: data_loss\ndrop table "public"."users";\n`,
    );
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(1);
    expect(stderr).toBe(
      [
        "current.sql has Hazards that --accept doesn't name:",
        '  data_loss: drop table "public"."users";',
        "to commit anyway, pass --accept data_loss",
        "",
      ].join("\n"),
    );
    expect(await readFile(file, "utf8")).toContain("-- hazard: data_loss");

    expect(
      await main(["commit", "create-users", "--accept", "data_loss", "--config", devConfig]),
    ).toBe(0);
    const committed = join(project, "db", "migrations", "000001-create-users.sql");
    expect(await readFile(committed, "utf8")).toContain("-- hazard: data_loss\n");
  });

  it("tells whether generate reset the Dev database, and prints plain text", async () => {
    const devConfig = join(project, "dev.config.ts");
    const file = relative(process.cwd(), join(project, "db", "migrations", "current.sql"));

    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(stdoutOf()).toBe(`wrote ${file}\nreset the Dev database\n`);

    written.mockClear();
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(stdoutOf()).toBe(`wrote ${file}\nleft the Dev database as it was\n`);
    expect(stdoutOf()).not.toContain("\u001B");
  });

  it("prints each Hazard generate returns, with its statement", async () => {
    const devConfig = join(project, "dev.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(0);
    await writeFile(join(project, "db", "narrow.ts"), DEFINITION.replace(", email: c.text()", ""));
    await writeFile(
      join(project, "narrow.config.ts"),
      config("SMONNDB_TEST_DEV_URL").replace("definition.ts", "narrow.ts"),
    );
    written.mockClear();

    expect(await main(["generate", "--config", join(project, "narrow.config.ts")])).toBe(0);

    expect(stdoutOf()).toContain(
      'hazard data_loss: alter table "public"."users" drop column "email";\n',
    );
  });

  it("prints what reset replayed", async () => {
    const devConfig = join(project, "dev.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(0);
    written.mockClear();

    expect(await main(["reset", "--config", devConfig])).toBe(0);
    expect(stdoutOf()).toBe("reset the Dev database from 1 Committed migration\n");
  });

  it("prints that reset also replayed current.sql when one is present", async () => {
    const devConfig = join(project, "dev.config.ts");
    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(await main(["commit", "create-users", "--config", devConfig])).toBe(0);
    await writeFile(join(project, "db", "narrow.ts"), DEFINITION.replace(", email: c.text()", ""));
    await writeFile(
      join(project, "narrow.config.ts"),
      config("SMONNDB_TEST_DEV_URL").replace("definition.ts", "narrow.ts"),
    );
    expect(await main(["generate", "--config", join(project, "narrow.config.ts")])).toBe(0);
    expect(await readdir(join(project, "db", "migrations"))).toContain("current.sql");
    written.mockClear();

    expect(await main(["reset", "--config", devConfig])).toBe(0);

    expect(stdoutOf()).toBe("reset the Dev database from 1 Committed migration and current.sql\n");
  });

  it("refuses to run while another command holds the Dev lock, on stderr with exit 1", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // The Dev lock's key, which dev-lock.ts keeps private.
    const code = await dev.driver.session(async (holder) => {
      await holder.query("select pg_advisory_lock(7666632338)");
      return main(["generate", "--config", join(project, "dev.config.ts")]);
    });

    expect(code).toBe(1);
    expect(written.mock.calls).toStrictEqual([]);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^can't generate: another generate, commit, or reset holds advisory lock \d+ on the Dev database\n$/u,
    );
  });

  it.each(["migrate", "verify", "reset"])(
    "exits 1 naming a missing migrations folder for %s",
    async (command) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(await main([...command.split(" "), "--config", join(project, "dev.config.ts")])).toBe(
        1,
      );

      const folder = join(project, "db", "migrations");
      expect(String(stderr.mock.calls[0]?.[0])).toBe(`the folder ${folder} doesn't exist\n`);
    },
  );

  it("generates, commits, and migrates a Definition into a second database", async () => {
    const devConfig = join(project, "dev.config.ts");
    const before = signalListeners();

    expect(await main(["generate", "--config", devConfig])).toBe(0);
    expect(signalListeners()).toStrictEqual(before);
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

    expect(stdout).toBe(
      `wrote ${join(basename(project), "db", "migrations", "current.sql")}\nreset the Dev database\n`,
    );
    expect(await readFile(join(project, "db", "migrations", "current.sql"), "utf8")).toContain(
      `create table "public"."users"`,
    );
  });
});
