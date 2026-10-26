import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function generateFrom(
  committed: string,
  definition: Parameters<typeof generate>[0]["definition"],
): Promise<GenerateResult> {
  const files =
    committed === "" ? [] : [await writeMigration("000001-create.sql", undefined, committed)];
  return generate(
    generateOptions(db, memoryFileSystem(filesIn("db/migrations", files)), definition),
  );
}

describe("generate under snake_case", () => {
  it("creates tables, columns, and derived names in snake_case", async () => {
    const result = await generateFrom(
      "",
      defineDatabase(
        {
          public: {
            userAccounts: defineTable((c) => ({
              userId: c.integer().primaryKey(),
              emailAddress: c.text().unique(),
            })),
          },
        },
        { casing: "snake_case" },
      ),
    );

    expect(result.sql).toContain('create table "public"."user_accounts"');
    expect(result.sql).toContain('"email_address" text');
    expect(result.sql).toContain('constraint "user_accounts_pkey" primary key ("user_id")');
    expect(result.sql).toContain(
      'constraint "user_accounts_email_address_key" unique ("email_address")',
    );
  });

  it("renames each name casing changes once it carries a renamedFrom", async () => {
    const result = await generateFrom(
      'create table public."userAccounts" ("userId" integer not null, "emailAddress" text);',
      defineDatabase(
        {
          public: {
            userAccounts: defineTable(
              (c) => ({
                userId: c.integer().notNull().renamedFrom("userId"),
                emailAddress: c.text().renamedFrom("emailAddress"),
              }),
              () => ({ renamedFrom: "userAccounts" }),
            ),
          },
        },
        { casing: "snake_case" },
      ),
    );

    expect(result.sql).toBe(
      [
        "-- hazard: rename",
        'alter table "public"."userAccounts" rename to "user_accounts";',
        "",
        "-- hazard: rename",
        'alter table "public"."user_accounts" rename column "userId" to "user_id";',
        "",
        "-- hazard: rename",
        'alter table "public"."user_accounts" rename column "emailAddress" to "email_address";',
        "",
      ].join("\n"),
    );
  });
});
