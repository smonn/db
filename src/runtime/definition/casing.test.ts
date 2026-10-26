import { describe, expect, it } from "vitest";
import { snakeCase } from "./casing.ts";
import { defineDatabase } from "./database.ts";
import { defineDomain } from "./define-domain.ts";
import { defineTable } from "./definition.ts";
import { defineEnum } from "./enum.ts";
import { sqlDefinition } from "./sql-definition.ts";

const userAccounts = () =>
  defineTable((c) => ({ userId: c.text().notNull(), emailAddress: c.text() }));

describe("snakeCase", () => {
  it.each([
    ["userId", "user_id"],
    ["userID", "user_id"],
    ["userIDs", "user_i_ds"],
    ["HTTPServer", "http_server"],
    ["line2Text", "line2_text"],
    ["address2", "address2"],
    ["already_snake", "already_snake"],
    ["PascalCase", "pascal_case"],
  ])("maps %s to %s", (key, name) => {
    expect(snakeCase(key)).toBe(name);
  });
});

describe("defineDatabase casing", () => {
  it("keeps keys verbatim by default", () => {
    const db = defineDatabase({ appData: { userAccounts: userAccounts() } });
    expect(db.appData.userAccounts).toMatchObject({
      schema: "appData",
      name: "userAccounts",
      columnNames: { userId: "userId", emailAddress: "emailAddress" },
    });
  });

  it("maps schema, table, and column keys to snake_case", () => {
    const db = defineDatabase(
      { appData: { userAccounts: userAccounts() } },
      { casing: "snake_case" },
    );
    expect(db.appData.userAccounts).toMatchObject({
      schema: "app_data",
      name: "user_accounts",
      columnNames: { userId: "user_id", emailAddress: "email_address" },
    });
  });

  it("maps enum and domain keys, keeping the values their columns hold", () => {
    const moodKind = defineEnum(["happyDay", "sad"]);
    const postCount = defineDomain((c) => c.integer(), { checks: { postCountMin: "value >= 0" } });
    const view = sqlDefinition(
      defineDatabase({ public: { moodKind, postCount } }, { casing: "snake_case" }),
    );
    expect(view).toHaveProperty(["public", "mood_kind"], moodKind);
    expect(view).toHaveProperty(["public", "post_count"], postCount);
    expect(moodKind.labels).toStrictEqual(["happyDay", "sad"]);
    expect(postCount.checks).toStrictEqual({ postCountMin: "value >= 0" });
  });

  it("lets an explicit name win over casing", () => {
    const mood = defineEnum(["a"], { name: "Mood" });
    const tally = defineDomain((c) => c.integer(), { name: "TallyType" });
    const people = defineTable(
      (c) => ({ userId: c.text().name("UserID"), fullName: c.text() }),
      () => ({ name: "People" }),
    );
    const db = defineDatabase({ public: { mood, tally, people } }, { casing: "snake_case" });
    expect(db.public.people).toMatchObject({
      name: "People",
      columnNames: { userId: "UserID", fullName: "full_name" },
    });
    const view = sqlDefinition(db);
    expect(view).toHaveProperty(["public", "Mood"], mood);
    expect(view).toHaveProperty(["public", "TallyType"], tally);
    expect(view).toHaveProperty(["public", "People", "name"], "People");
  });

  it("takes an override without casing too", () => {
    const db = defineDatabase({
      public: { people: defineTable((c) => ({ id: c.text().name("person_id") })) },
    });
    expect(db.public.people.columnNames).toStrictEqual({ id: "person_id" });
  });

  it("names a table's foreign key targets by SQL names, as its own schema and name are", () => {
    const teams = defineTable((c) => ({ teamId: c.text().primaryKey() }));
    const members = defineTable((c) => ({
      teamRef: c.text().references(() => teams.columns.teamId),
    }));
    const db = defineDatabase({ appData: { teamList: teams, members } }, { casing: "snake_case" });
    expect(db.appData.members.foreignKeys.map(({ target }) => target)).toStrictEqual([
      { schema: "app_data", table: "team_list", columns: ["team_id"] },
    ]);
  });

  it("keys the SQL view's tables, keys, and foreign key targets by SQL names", () => {
    const teams = defineTable((c) => ({ teamId: c.text().primaryKey() }));
    const members = defineTable(
      (c) => ({ memberId: c.text(), teamRef: c.text().references(() => teams.columns.teamId) }),
      (t) => ({ primaryKey: [t.memberId, t.teamRef] }),
    );
    const view = sqlDefinition(
      defineDatabase({ public: { teamList: teams, members } }, { casing: "snake_case" }),
    );
    expect(view).toHaveProperty(["public", "members"], {
      ...members,
      schema: "public",
      name: "members",
      columns: { member_id: members.columns.memberId, team_ref: members.columns.teamRef },
      columnNames: { member_id: "member_id", team_ref: "team_ref" },
      primaryKey: ["member_id", "team_ref"],
      foreignKeys: [
        {
          name: undefined,
          columns: ["team_ref"],
          target: { schema: "public", table: "team_list", columns: ["team_id"] },
          onDelete: "no action",
          onUpdate: "no action",
          match: "simple",
          deferrable: "not deferrable",
        },
      ],
    });
  });
});
