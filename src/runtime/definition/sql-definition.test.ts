import { describe, expect, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable } from "./definition.ts";
import { defineEnum } from "./enum.ts";
import { sqlDefinition } from "./sql-definition.ts";

const userAccounts = () => defineTable((c) => ({ userId: c.text() }));

describe("sqlDefinition without the view defineDatabase keeps", () => {
  it("refuses a copy whose tables' SQL names differ from their keys", () => {
    const db = defineDatabase(
      { appData: { userAccounts: userAccounts() } },
      { casing: "snake_case" },
    );
    expect(() => sqlDefinition({ ...db })).toThrow(
      'The Definition names "appData"."userAccounts" by its keys, though defineDatabase mapped it to SQL names; pass the object defineDatabase returned, not a copy such as { ...db }',
    );
  });

  it("refuses a column whose SQL name differs from its key", () => {
    const people = defineTable((c) => ({ id: c.text().name("person_id") }));
    const db = defineDatabase({ public: { people } });
    expect(() => sqlDefinition({ ...db })).toThrow('names "public"."people" by its keys');
  });

  it("refuses a type whose explicit name differs from its key", () => {
    const db = defineDatabase({ public: { mood: defineEnum(["a"], { name: "feeling" }) } });
    expect(() => sqlDefinition({ ...db })).toThrow('names "public"."mood" by its keys');
  });

  it("reads a copy whose keys are its SQL names", () => {
    const db = defineDatabase({ public: { users: userAccounts(), mood: defineEnum(["a"]) } });
    const copy = { ...db };
    expect(sqlDefinition(copy)).toBe(copy);
  });
});
