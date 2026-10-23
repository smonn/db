import { beforeEach, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

it("writes each Hazard as a comment above its statement and returns it", async () => {
  const fileSystem = memoryFileSystem(
    filesIn("db/migrations", [
      await writeMigration(
        "000001-create.sql",
        undefined,
        "create table public.users (id integer not null, nickname text);\ncreate table public.old (id integer);\n",
      ),
    ]),
  );
  const definition = defineDatabase({
    public: { users: defineTable((c) => ({ id: c.bigint().notNull() })) },
  });

  const result = await generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });

  const dropColumn = `alter table "public"."users" drop column "nickname";`;
  const dropTable = `drop table "public"."old";`;
  const retype = `alter table "public"."users" alter column "id" type bigint;`;
  expect(result.sql).toBe(
    `-- hazard: data_loss\n${dropColumn}\n\n-- hazard: data_loss\n${dropTable}\n\n` +
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\n${retype}\n`,
  );
  expect(result.hazards).toStrictEqual([
    { kind: "data_loss", statement: dropColumn },
    { kind: "data_loss", statement: dropTable },
    { kind: "rewrite", statement: retype },
    { kind: "access_exclusive_lock", statement: retype },
  ]);
  expect(fileSystem.files.get("db/migrations/current.sql")).toContain(
    `-- hazard: data_loss\n${dropColumn}`,
  );
});
