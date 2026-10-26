import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

/** Generates the Definition against one Committed migration that runs `committed`. */
async function generateFrom(
  committed: string,
  definition: Parameters<typeof generate>[0]["definition"],
): Promise<GenerateResult> {
  const fileSystem = memoryFileSystem(
    filesIn("db/migrations", [await writeMigration("000001-create.sql", undefined, committed)]),
  );
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });
}

const USERS = "create table public.users (id integer not null, name text not null);";

describe("a column rename", () => {
  it("renames the column with the rename Hazard, not a drop and add", async () => {
    const result = await generateFrom(
      USERS,
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.integer().notNull(),
            full_name: c.text().notNull().renamedFrom("name"),
          })),
        },
      }),
    );

    const statement = `alter table "public"."users" rename column "name" to "full_name";`;
    expect(result.sql).toBe(`-- hazard: rename\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "rename", statement }]);
    expect(result.hints).toStrictEqual([]);
  });

  it("runs the rename first, then the retype under the new name", async () => {
    const result = await generateFrom(
      USERS,
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.bigint().notNull(),
            full_name: c.text().notNull().renamedFrom("name"),
          })),
        },
      }),
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "public"."users" rename column "name" to "full_name";`,
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\n` +
        `alter table "public"."users" alter column "id" type bigint;`,
    ]);
  });

  it("ignores a marker whose old name is gone", async () => {
    const result = await generateFrom(
      "create table public.users (id integer not null, full_name text not null);",
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.integer().notNull(),
            full_name: c.text().notNull().renamedFrom("name"),
          })),
        },
      }),
    );

    expect(result.sql).toBeUndefined();
  });

  it("throws when the old and new names both exist", async () => {
    await expect(
      generateFrom(
        "create table public.users (id integer not null, name text, full_name text);",
        defineDatabase({
          public: {
            users: defineTable((c) => ({
              id: c.integer().notNull(),
              name: c.text(),
              full_name: c.text().renamedFrom("name"),
            })),
          },
        }),
      ),
    ).rejects.toThrow('column "public"."users"."full_name" has renamedFrom "name"');
  });
});

describe("a table rename", () => {
  it("renames the table, then the column inside it", async () => {
    const result = await generateFrom(
      USERS,
      defineDatabase({
        public: {
          people: defineTable(
            (c) => ({
              id: c.integer().notNull(),
              full_name: c.text().notNull().renamedFrom("name"),
            }),
            () => ({ renamedFrom: "users" }),
          ),
        },
      }),
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "public"."users" rename to "people";`,
      `-- hazard: rename\nalter table "public"."people" rename column "name" to "full_name";`,
    ]);
  });

  it("leaves the columns and defaults alone, which Postgres follows by OID", async () => {
    const result = await generateFrom(
      "create table public.users (id integer not null, tag text default upper('x'));",
      defineDatabase({
        public: {
          people: defineTable(
            (c) => ({
              id: c.integer().notNull(),
              tag: c.text().default("upper('x')"),
            }),
            () => ({ renamedFrom: "users" }),
          ),
        },
      }),
    );

    expect(result.sql).toBe(
      `-- hazard: rename\nalter table "public"."users" rename to "people";\n`,
    );
  });

  it("fails with Postgres's own error when the rename can't run", async () => {
    const committed =
      "create table public.users (id integer not null); create table public.other (id integer);" +
      "create index people on public.other (id);";
    const other = defineTable((c) => ({ id: c.integer() }));
    const people = defineTable(
      (c) => ({ id: c.integer().notNull() }),
      () => ({ renamedFrom: "users" }),
    );

    await expect(
      generateFrom(committed, defineDatabase({ public: { people, other } })),
    ).rejects.toThrow(/already exists/u);
  });

  it("ignores a marker whose old name is gone", async () => {
    const result = await generateFrom(
      "create table public.people (id integer not null, name text not null);",
      defineDatabase({
        public: {
          people: defineTable(
            (c) => ({ id: c.integer().notNull(), name: c.text().notNull() }),
            () => ({ renamedFrom: "users" }),
          ),
        },
      }),
    );

    expect(result.sql).toBeUndefined();
  });
});

describe("rename hints", () => {
  it("names the column marker to add, and leaves the SQL a drop and add", async () => {
    const result = await generateFrom(
      USERS,
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.integer().notNull(),
            full_name: c.text().notNull(),
          })),
        },
      }),
    );

    expect(result.hints).toStrictEqual([
      'column "public"."users"."full_name" may be a rename of "name": add .renamedFrom("name") to it',
    ]);
    expect(result.sql).toContain(`drop column "name"`);
    expect(result.sql).not.toContain("rename");
  });

  it("names the table marker to add", async () => {
    const result = await generateFrom(
      USERS,
      defineDatabase({
        public: {
          people: defineTable((c) => ({
            id: c.integer().notNull(),
            name: c.text().notNull(),
          })),
        },
      }),
    );

    expect(result.hints).toStrictEqual([
      'table "public"."people" may be a rename of "users": add renamedFrom: "users" to its second callback',
    ]);
  });
});
