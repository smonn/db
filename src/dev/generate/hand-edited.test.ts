import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { sha256 } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

const definition = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text() })) },
});

async function generated(body: string): Promise<string> {
  return `--! Generated: sha256:${await sha256(body)}\n\n${body}`;
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate with a hand-edited current.sql", () => {
  const USERS_DIFF = '+create table "public"."users" (\n+  "id" text\n+);\n';

  it.each([
    [
      "an edited body",
      async () => `${await generated("select 1;\n")}select 2;\n`,
      "select 1;\nselect 2;\n",
      `-select 1;\n-select 2;\n${USERS_DIFF}`,
    ],
    [
      "no Generated header",
      () => Promise.resolve("select 1;\n"),
      "select 1;\n",
      `-select 1;\n${USERS_DIFF}`,
    ],
  ])("keeps and replays a current.sql with %s", async (_, build, body, diff) => {
    const content = await build();
    const fileSystem = memoryFileSystem({ [CURRENT]: content });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(fileSystem.files.get(CURRENT)).toBe(content);
    expect(result).toStrictEqual({ path: CURRENT, sql: body, diff, reset: true, hazards: [] });
    const { rows: tables } = await db.driver.query(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables).toStrictEqual([]);
    const { rows: hashes } = await db.driver.query("select hash from smonn_db.current");
    expect(hashes).toStrictEqual([{ hash: `sha256:${await sha256(body)}` }]);
  });

  it("reports an empty diff when the edit still matches what generate would write", async () => {
    const body = 'create table "public"."users" (\n  "id" text\n);\n';
    const fileSystem = memoryFileSystem({
      [CURRENT]: `--! Generated: sha256:${"0".repeat(64)}\n\n${body}`,
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result.diff).toBe("");
  });

  it("resumes generating once the hand-edited current.sql is deleted", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select 1;\n" });
    const options = {
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    };
    await generate(options);
    await fileSystem.remove(CURRENT);

    const result = await generate(options);

    expect(result.diff).toBeUndefined();
    expect(fileSystem.files.get(CURRENT)).toBe(await generated(String(result.sql)));
  });
});
