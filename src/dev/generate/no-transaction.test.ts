import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

const definition = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });

const INDEX = "create index concurrently users_id on public.users (id);\n";
const EDIT = `--! no-transaction\n\n${INDEX}`;
const CREATE_USERS = await writeMigration(
  "000001-create-users.sql",
  undefined,
  "create table public.users (id text);\n",
);

function folderWith(current: string): ReturnType<typeof memoryFileSystem> {
  return memoryFileSystem({ ...filesIn(MIGRATIONS, [CREATE_USERS]), [CURRENT]: current });
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate and commit with a no-transaction hand edit (ADR-0020)", () => {
  it("checks the edit in the Shadow outside a transaction, replays it, and commit carries the header", async () => {
    const fileSystem = folderWith(EDIT);

    const result = await generate(generateOptions(db, fileSystem, definition));
    const { path } = await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "index-id",
      accept: [],
    });

    const expected = await writeMigration("000002-index-id.sql", CREATE_USERS.hash, INDEX, {
      noTransaction: true,
    });
    expect(result.reset).toBe(true);
    expect(fileSystem.files.get(path)).toBe(expected.content);
    expect(expected.content).toContain(`--! Hash: ${expected.hash}\n--! no-transaction\n\n`);
    expect(fileSystem.files.has(CURRENT)).toBe(false);
    expect(
      (await db.driver.query("select filename, hash, status from smonn_db.migrations")).rows,
    ).toStrictEqual([
      { filename: CREATE_USERS.filename, hash: CREATE_USERS.hash, status: "applied" },
      { filename: expected.filename, hash: expected.hash, status: "applied" },
    ]);
  });

  it.each([
    ["the same statement without the header, which the Shadow runs in a transaction", INDEX],
    [
      "two statements under the header, which Postgres runs as one transaction",
      `${EDIT}create index concurrently users_id2 on public.users (id);\n`,
    ],
  ])("refuses %s", async (_, current) => {
    const fileSystem = folderWith(current);

    await expect(generate(generateOptions(db, fileSystem, definition))).rejects.toMatchObject({
      code: "25001",
    });
  });
});
