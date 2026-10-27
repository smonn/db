import { describe, expect, it } from "vitest";
import { placesOf } from "./foreign-keys.ts";

describe("placesOf", () => {
  it("records where each column of a table lives, and skips every entry that isn't one", () => {
    const id = { name: "id" };
    const note = { name: "note" };
    const primaryKey = ["id"];

    const places = placesOf({
      public: {
        users: { columns: { id, note }, primaryKey },
        status: { values: ["on"] },
        keyless: { columns: { id: { name: "other" } } },
        columnless: { primaryKey: ["id"] },
        nothing: null,
        text: "columns primaryKey",
        number: 3,
      },
    });

    expect([...places.keys()]).toStrictEqual([id, note]);
    expect(places.get(id)).toStrictEqual([
      { schema: "public", table: "users", column: "id", primaryKey },
    ]);
  });

  it("lists every table a column value is rolled up under", () => {
    const id = { name: "id" };
    const table = { columns: { id }, primaryKey: ["id"] };

    const places = placesOf({ public: { a: table }, archive: { b: table } });

    expect(places.get(id)?.map(({ schema, table: name }) => `${schema}.${name}`)).toStrictEqual([
      "public.a",
      "archive.b",
    ]);
  });
});
