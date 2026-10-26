import { describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { DriverRow } from "../ports/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";

const db = defineDatabase(
  {
    appData: {
      userAccounts: defineTable((c) => ({
        userId: c.text().notNull(),
        emailAddress: c.text(),
        nick: c.text().name("NickName"),
      })),
    },
  },
  { casing: "snake_case" },
);
const users = db.appData.userAccounts;

describe("builder queries under casing", () => {
  it("select each column by its SQL name, aliased back to its key", () => {
    expect(from(users).toSql().text).toBe(
      'select "user_id" as "userId", "email_address" as "emailAddress", "NickName" as "nick" from "app_data"."user_accounts"',
    );
  });

  it("filter and pick by SQL name, keeping a picked alias", () => {
    const query = from(users)
      .select((u) => ({ mail: u.emailAddress, nick: u.nick }))
      .where((u) => u.userId.eq("u1"));
    expect(query.toSql()).toStrictEqual({
      text: 'select "email_address" as "mail", "NickName" as "nick" from "app_data"."user_accounts" where "user_id" = $1',
      params: ["u1"],
    });
  });

  it("insert into SQL names and return keys", () => {
    const statement = insert(users)
      .values({ userId: "u1", emailAddress: "a@example.com" })
      .returning((u) => ({ userId: u.userId }));
    expect(statement.toSql().text).toBe(
      'insert into "app_data"."user_accounts" ("user_id", "email_address") values ($1, $2) returning "user_id" as "userId"',
    );
  });
});

describe("rows under casing", () => {
  const testDatabase = useTestDatabase();
  const client = createClient(testDatabase.driver);

  it("come back keyed by key from the builder and by SQL name from raw sql", async () => {
    await testDatabase.driver.execute(`
      create schema app_data;
      create table app_data.user_accounts (user_id text not null, email_address text, "NickName" text);
    `);

    const inserted = await client.all(
      insert(users)
        .values({ userId: "u1", emailAddress: "a@example.com", nick: "Al" })
        .returning((u) => ({ userId: u.userId, emailAddress: u.emailAddress })),
    );
    expect(inserted).toStrictEqual([{ userId: "u1", emailAddress: "a@example.com" }]);

    const selected = await client.all(from(users));
    expect(selected).toStrictEqual([{ userId: "u1", emailAddress: "a@example.com", nick: "Al" }]);
    expectTypeOf(selected).toEqualTypeOf<
      { userId: string; emailAddress: string | null; nick: string | null }[]
    >();

    const raw = await client.all(sql<DriverRow>`select * from app_data.user_accounts`);
    expect(raw).toStrictEqual([{ user_id: "u1", email_address: "a@example.com", NickName: "Al" }]);
  });
});
