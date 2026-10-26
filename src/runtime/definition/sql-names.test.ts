import { describe, expect, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable } from "./definition.ts";
import { defineEnum } from "./enum.ts";

describe("defineDatabase refuses two keys that take one SQL name", () => {
  it("in one table's columns", () => {
    const clash = defineTable((c) => ({ userId: c.text(), user_id: c.text() }));
    expect(() => defineDatabase({ public: { clash } }, { casing: "snake_case" })).toThrow(
      'The columns of "public"."clash" "userId" and "user_id" both map to the SQL name "user_id"; give one of them another name with .name()',
    );
  });

  it("when an override takes another column's name", () => {
    const clash = defineTable((c) => ({ a: c.text(), b: c.text().name("a") }));
    expect(() => defineDatabase({ public: { clash } })).toThrow(
      '"a" and "b" both map to the SQL name "a"',
    );
  });

  it("for a table and a type in one schema", () => {
    const userKind = defineEnum(["a"]);
    const user_kind = defineTable((c) => ({ id: c.text() }));
    expect(() =>
      defineDatabase({ public: { userKind, user_kind } }, { casing: "snake_case" }),
    ).toThrow(
      'The keys of schema "public" "userKind" and "user_kind" both map to the SQL name "user_kind"',
    );
  });

  it("for two schemas", () => {
    expect(() => defineDatabase({ appData: {}, app_data: {} }, { casing: "snake_case" })).toThrow(
      'The schema keys "appData" and "app_data" both map to the SQL name "app_data"',
    );
  });
});

describe("defineDatabase options", () => {
  it("refuses an unknown option or casing", () => {
    // @ts-expect-error -- not an option.
    expect(() => defineDatabase({}, { naming: "snake_case" })).toThrow(
      'defineDatabase does not take the option "naming"',
    );
    // @ts-expect-error -- not a casing.
    expect(() => defineDatabase({}, { casing: "camelCase" })).toThrow(
      'defineDatabase takes casing "snake_case", not "camelCase"',
    );
  });

  it("refuses a table name that isn't a string", () => {
    expect(() =>
      defineTable(
        (c) => ({ id: c.text() }),
        // @ts-expect-error -- the name is a string.
        () => ({ name: 1 }),
      ),
    ).toThrow("The table's name takes its SQL name as a string");
  });
});
