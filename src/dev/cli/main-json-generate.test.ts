import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { nodeFileSystem } from "../../adapters/node/index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { parseMigration, readCommitted, writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const cli = useCliProject();
const dev = useTestDatabase();

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

const USERS = "users: defineTable((c) => ({ id: c.text().notNull() }))";
const KEYED = "users: defineTable((c) => ({ key: c.text().notNull() }))";
const NOTHING = "";

beforeEach(async () => {
  await dev.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

let config: string;
let version = 0;

/** Points `config` at a project whose Definition holds `tables`, in fresh files, since an import is cached. */
async function writeProject(tables: string, strict = false): Promise<void> {
  version += 1;
  await mkdir(join(cli.dir, "migrations"), { recursive: true });
  await writeFile(
    join(cli.dir, `definition-${version}.ts`),
    `import { defineDatabase, defineTable } from "${source("../../runtime/definition/index.ts")}";\n\nexport default defineDatabase({ public: { ${tables} } });\n`,
  );
  config = join(cli.dir, `smonndb-${version}.config.ts`);
  await writeFile(
    config,
    `import { defineConfig } from "${source("../config/index.ts")}";\n\nexport default defineConfig({ definition: "./definition-${version}.ts", migrations: "./migrations", url: ${JSON.stringify(dev.url)}, strict: ${String(strict)} });\n`,
  );
}

/** Runs `generate --json` and reads the one line of JSON it alone printed on stdout. */
async function generateJson(): Promise<{ code: number; document: unknown }> {
  const before = cli.stdout.length;
  const code = await main(["generate", "--json", "--config", config]);
  const printed = cli.stdout.slice(before);
  expect(printed.endsWith("\n")).toBe(true);
  expect(printed.trimEnd()).not.toContain("\n");
  return { code, document: JSON.parse(printed) };
}

/** Adds a Committed file after the last one, as a pull from another branch would. */
async function pull(filename: string, sql: string): Promise<void> {
  const folder = join(cli.dir, "migrations");
  const last = (await readCommitted(nodeFileSystem(), folder)).at(-1);
  const previous = last === undefined ? undefined : parseMigration(last).hash;
  const file = await writeMigration(filename, previous, sql);
  await writeFile(join(folder, filename), file.content);
}

const CURRENT = (): string => join(cli.dir, "migrations", "current.sql");
const SHOWN = (): string => relative(process.cwd(), CURRENT());

describe("main generate --json", () => {
  it("prints the file it wrote and that it reset an empty Dev database", async () => {
    await writeProject(USERS);

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "generate",
      ok: true,
      file: { path: SHOWN(), action: "written", handEdited: false },
      hazards: [],
      hints: [],
      devDatabase: { kind: "reset" },
    });
  });

  it("prints a kept file and no catch-up for a run that changes nothing", async () => {
    await writeProject(USERS);
    expect(await main(["generate", "--config", config])).toBe(0);

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "generate",
      ok: true,
      file: { path: SHOWN(), action: "kept", handEdited: false },
      hazards: [],
      hints: [],
      devDatabase: { kind: "none" },
    });
  });

  it("prints an absent file when there is no diff and no file to remove", async () => {
    await writeProject(NOTHING);
    expect(await main(["generate", "--config", config])).toBe(0);

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "generate",
      ok: true,
      file: { path: SHOWN(), action: "absent", handEdited: false },
      hazards: [],
      hints: [],
      devDatabase: { kind: "none" },
    });
  });

  it("prints a removed file when the Definition no longer differs from the Committed migrations", async () => {
    await writeProject(USERS);
    expect(await main(["generate", "--config", config])).toBe(0);
    expect(await main(["commit", "create-users", "--config", config])).toBe(0);
    await writeProject(KEYED);
    expect(await main(["generate", "--config", config])).toBe(0);
    await writeProject(USERS);

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toMatchObject({
      command: "generate",
      file: { path: SHOWN(), action: "removed", handEdited: false },
      hazards: [],
    });
  });

  it("prints the Hazards and hints of a change", async () => {
    await writeProject(USERS);
    expect(await main(["generate", "--config", config])).toBe(0);
    expect(await main(["commit", "create-users", "--config", config])).toBe(0);
    await writeProject(KEYED);

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toMatchObject({
      command: "generate",
      file: { action: "written", handEdited: false },
      hazards: [
        { kind: "data_loss", statement: expect.stringContaining("drop column") as unknown },
      ],
      hints: [expect.stringContaining(".renamedFrom(") as unknown],
    });
  });

  it("prints the files it replayed and the Hazards in the Committed ones", async () => {
    await writeProject(USERS);
    expect(await main(["generate", "--config", config])).toBe(0);
    expect(await main(["commit", "create-users", "--config", config])).toBe(0);
    await pull("000002-add-email.sql", 'alter table "public"."users" add column "email" text;\n');
    await pull(
      "000003-drop-email.sql",
      '-- hazard: data_loss\nalter table "public"."users" drop column "email";\n',
    );

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toMatchObject({
      command: "generate",
      file: { action: "absent" },
      devDatabase: {
        kind: "replayed",
        files: ["000002-add-email.sql", "000003-drop-email.sql"],
        hazards: [
          {
            file: "000003-drop-email.sql",
            kind: "data_loss",
            statement: 'alter table "public"."users" drop column "email";',
          },
        ],
      },
    });
  });

  it("prints a hand edit's diff and its leftover, and keeps the file as written", async () => {
    await writeProject(USERS);
    await writeFile(CURRENT(), "select 1;\n");

    const { code, document } = await generateJson();

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "generate",
      ok: true,
      file: {
        path: SHOWN(),
        action: "kept",
        handEdited: true,
        diff: '-select 1;\n+create table "public"."users" (\n+  "id" text not null\n+);\n',
        leftover: expect.stringContaining('table "public"."users" is missing') as unknown,
      },
      hazards: [],
      hints: [],
      devDatabase: { kind: "reset" },
    });
    expect(await readFile(CURRENT(), "utf8")).toBe("select 1;\n");
  });

  it("prints a leftover failure under strict: true, and leaves the Dev database alone", async () => {
    await writeProject(USERS, true);
    await writeFile(CURRENT(), "select 1;\n");

    const { code, document } = await generateJson();

    expect(code).toBe(1);
    expect(document).toStrictEqual({
      command: "generate",
      ok: false,
      error: {
        code: "leftover",
        message: expect.stringContaining("current.sql leaves a difference") as unknown,
        leftover: expect.stringContaining("the Shadow database") as unknown,
      },
    });
  });
});
