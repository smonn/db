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

describe("defaults, identity, and keys", () => {
  const definition = defineDatabase({
    public: {
      accounts: defineTable((c) => ({
        id: c.integer().identity("always").primaryKey(),
        status: c.text().default("'new'"),
        created_at: c.timestamptz().default("now()"),
        email: c.text().unique(),
      })),
      memberships: defineTable((c) => ({
        account_id: c.integer().primaryKey(),
        team_id: c.integer().primaryKey(),
      })),
    },
  });

  it("creates each one and verifies the Shadow database matches", async () => {
    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem: memoryFileSystem(),
      definition,
      migrations: "db/migrations",
    });

    expect(result.sql).toContain(`"accounts_pkey" primary key ("id")`);
    expect(result.sql).toContain(`"accounts_email_key" unique ("email")`);
    expect(result.sql).toContain(`"memberships_pkey" primary key ("account_id", "team_id")`);
  });

  it("finds no difference from a Committed migration that adds them with Postgres's names", async () => {
    const fileSystem = memoryFileSystem({
      ...filesIn("db/migrations", [
        await writeMigration(
          "000001-create-tables.sql",
          undefined,
          `create table public.accounts (
  id integer generated always as identity primary key,
  status text default 'new',
  created_at timestamptz default now(),
  email text unique
);
create table public.memberships (
  account_id integer,
  team_id integer,
  primary key (account_id, team_id)
);
`,
        ),
      ]),
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result).toStrictEqual({ path: CURRENT, sql: undefined, reset: true, hazards: [] });
  });
});
