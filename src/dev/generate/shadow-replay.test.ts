import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate in the Shadow database", () => {
  it("refuses SQL that leaves the Shadow unlike the Definition, naming the difference", async () => {
    // An event trigger in the Shadow adds a column to every table the Current migration creates.
    const fileSystem = memoryFileSystem(
      filesIn("db/migrations", [
        await writeMigration(
          "000001-audit.sql",
          undefined,
          `create function public.audit() returns event_trigger language plpgsql as $$
declare created record;
begin
  for created in select object_identity from pg_event_trigger_ddl_commands() loop
    execute format('alter table %s add column audited text', created.object_identity);
  end loop;
end $$;
create event trigger audit on ddl_command_end when tag in ('CREATE TABLE')
  execute function public.audit();
`,
        ),
      ]),
    );

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem,
        definition: defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(
      `the Current migration leaves the Shadow database unlike the Definition database:\n  column "public"."users"."audited" is only in the Shadow database`,
    );
    expect(fileSystem.files.has(CURRENT)).toBe(false);
  });

  it("replays with check_function_bodies on, refusing a SQL function that names a missing table", async () => {
    const fileSystem = memoryFileSystem(
      filesIn("db/migrations", [
        await writeMigration(
          "000001-count.sql",
          undefined,
          "create function public.total() returns bigint language sql as 'select count(*) from public.missing';\n",
        ),
      ]),
    );

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem,
        definition: defineDatabase({ public: {} }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(`relation "public.missing" does not exist`);
  });
});
