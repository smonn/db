import { describe, expect, it } from "vitest";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
} from "../../runtime/definition/index.ts";
import { sql } from "../../runtime/query/index.ts";
import { definitionCatalog } from "./definition-catalog.ts";
import { declaredRenames } from "./renames.ts";

const moodKind = defineEnum(["happyDay", "sad"]);
const postCount = defineDomain((c) => c.integer(), { checks: { postCountMin: "value >= 0" } });

const teamList = defineTable((c) => ({ teamId: c.text().primaryKey() }));

const userAccounts = defineTable(
  (c) => ({
    userId: c.integer().identity(),
    emailAddress: c.text().unique(),
    displayName: c.text().index(),
    teamRef: c.text().references(() => teamList.columns.teamId),
    currentMood: c.enum(moodKind),
    postTotal: c.domain(postCount),
    deletedAt: c.timestamptz(),
    nickName: c.text().unique({ name: "nickNameUnique" }),
  }),
  (t) => ({
    primaryKey: [t.userId, t.emailAddress],
    unique: [{ columns: [t.displayName, t.teamRef] }],
    indexes: [
      { columns: [t.teamRef, t.displayName] },
      {
        columns: [sql`lower(${t.emailAddress})`],
        name: "emailLowerIdx",
        where: sql`${t.deletedAt} is null`,
      },
    ],
  }),
);

const catalog = definitionCatalog(
  defineDatabase(
    { appData: { moodKind, postCount, teamList, userAccounts } },
    { casing: "snake_case" },
  ),
);

const facts = [...catalog.values()];
const named = (kind: string) => facts.filter((fact) => fact.kind === kind).map((fact) => fact.name);
const payloadOf = (kind: string, name: string) =>
  facts.find((fact) => fact.kind === kind && fact.name === name)?.payload;

describe("definitionCatalog under snake_case", () => {
  it("names schemas, tables, columns, enums, and domains by their mapped SQL names", () => {
    expect(named("schema")).toStrictEqual(["app_data"]);
    expect(named("table")).toStrictEqual(["team_list", "user_accounts"]);
    expect(named("enum")).toStrictEqual(["mood_kind"]);
    expect(named("domain")).toStrictEqual(["post_count"]);
    expect(named("column")).toContain("email_address");
    expect(named("column")).not.toContain("emailAddress");
  });

  it("keeps enum labels, domain check names, and given constraint and index names verbatim", () => {
    const mood = facts.find((fact) => fact.kind === "enum");
    expect(mood?.payload).toStrictEqual({ labels: ["happyDay", "sad"] });
    expect(named("domain check")).toStrictEqual(["postCountMin"]);
    expect(named("unique")).toContain("nickNameUnique");
    expect(named("index")).toContain("emailLowerIdx");
  });

  it("types an enum or domain column by the type's mapped name", () => {
    expect(payloadOf("column", "current_mood")).toMatchObject({ type: "app_data.mood_kind" });
    expect(payloadOf("column", "post_total")).toMatchObject({ type: "app_data.post_count" });
  });

  it("derives constraint and index names from the mapped SQL names", () => {
    expect(named("primary key")).toStrictEqual(["team_list_pkey", "user_accounts_pkey"]);
    expect(named("unique")).toStrictEqual([
      "user_accounts_email_address_key",
      "nickNameUnique",
      "user_accounts_display_name_team_ref_key",
    ]);
    expect(named("index")).toStrictEqual([
      "user_accounts_display_name_idx",
      "user_accounts_team_ref_display_name_idx",
      "emailLowerIdx",
    ]);
    expect(named("foreign key")).toStrictEqual(["user_accounts_team_ref_fkey"]);
  });

  it("points a foreign key at its target's SQL names", () => {
    const key = facts.find((fact) => fact.kind === "foreign key");
    expect(key?.payload).toMatchObject({
      columns: ["team_ref"],
      target: { schema: "app_data", table: "team_list", columns: ["team_id"] },
    });
  });

  it("renders an expression key and predicate with SQL names", () => {
    expect(payloadOf("index", "emailLowerIdx")).toMatchObject({
      keys: [{ expression: 'lower("email_address")' }],
      where: '"deleted_at" is null',
    });
  });

  it("refuses a derived name that clashes with a mapped identity sequence", () => {
    const clash = defineTable((c) => ({
      rowId: c.integer().identity(),
      other: c.text().unique({ name: "things_row_id_seq" }),
    }));
    expect(() =>
      definitionCatalog(defineDatabase({ public: { things: clash } }, { casing: "snake_case" })),
    ).toThrow('which is also the name of the identity sequence of "public"."things" ("row_id")');
  });
});

describe("declaredRenames under snake_case", () => {
  it("names the new objects by SQL names and keeps each old name verbatim", () => {
    const people = defineTable(
      (c) => ({ fullName: c.text().renamedFrom("fullName") }),
      () => ({ renamedFrom: "Persons" }),
    );
    const feeling = defineEnum(["a"], { renamedFrom: "oldMood" });
    expect(
      declaredRenames(
        defineDatabase({ app: { peopleList: people, feeling } }, { casing: "snake_case" }),
      ),
    ).toStrictEqual([
      { kind: "table", schema: "app", name: "people_list", was: "Persons" },
      { kind: "column", schema: "app", table: "people_list", name: "full_name", was: "fullName" },
      { kind: "enum", schema: "app", name: "feeling", was: "oldMood" },
    ]);
  });
});
