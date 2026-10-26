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

describe("defineDatabase refuses a SQL name Postgres can't hold", () => {
  const fix = "takes a SQL name of 1 to 63 bytes";

  it("for an empty explicit name", () => {
    const column = defineTable((c) => ({ a: c.text().name("") }));
    expect(() => defineDatabase({ s: { t: column } })).toThrow(
      `The column key "a" of "s"."t" ${fix}, not ""`,
    );
    const table = defineTable(
      (c) => ({ a: c.text() }),
      () => ({ name: "" }),
    );
    expect(() => defineDatabase({ s: { t: table } })).toThrow(
      `The key "t" of schema "s" ${fix}, not ""`,
    );
  });

  it("for an explicit name that isn't a string", () => {
    // @ts-expect-error -- the name is a string.
    const mood = defineEnum(["x"], { name: 5 });
    expect(() => defineDatabase({ s: { mood } })).toThrow(
      `The key "mood" of schema "s" ${fix}, not 5`,
    );
    // @ts-expect-error -- the name is a string.
    const column = defineTable((c) => ({ a: c.text().name(5) }));
    expect(() => defineDatabase({ s: { t: column } })).toThrow(
      `The column key "a" of "s"."t" ${fix}`,
    );
  });

  it("for a mapped name over 63 bytes, counted in UTF-8", () => {
    const key = "aB".repeat(22);
    const long = defineTable((c) => ({ [key]: c.text() }));
    expect(() => defineDatabase({ s: { t: long } })).not.toThrow();
    expect(() => defineDatabase({ s: { t: long } }, { casing: "snake_case" })).toThrow(
      `The column key "${key}" of "s"."t" ${fix}`,
    );
    expect(() => defineDatabase({ ["é".repeat(32)]: {} })).toThrow(
      `The schema key "${"é".repeat(32)}" ${fix}`,
    );
  });
});
