import { describe, expect, it } from "vitest";
import { identifier, join, sql } from "./sql.ts";

describe("sql", () => {
  it("renders text without params", () => {
    expect(sql`select 1`.toSql()).toStrictEqual({ text: "select 1", params: [] });
  });

  it("binds each value to a numbered placeholder", () => {
    const fragment = sql`select ${1}::int + ${"2"}::int, ${null}`;
    expect(fragment.toSql()).toStrictEqual({
      text: "select $1::int + $2::int, $3",
      params: [1, "2", null],
    });
  });

  it("inlines a nested fragment and renumbers its params", () => {
    const filter = sql`n > ${5}`;
    const fragment = sql`select ${"a"} from t where ${filter} and m = ${6}`;
    expect(fragment.toSql()).toStrictEqual({
      text: "select $1 from t where n > $2 and m = $3",
      params: ["a", 5, 6],
    });
  });

  it("inlines a fragment that starts and ends with a value", () => {
    const inner = sql`${1}${2}`;
    expect(sql`(${inner})`.toSql()).toStrictEqual({ text: "($1$2)", params: [1, 2] });
  });
});

describe("identifier", () => {
  it("double-quotes a name", () => {
    expect(identifier("users").toSql()).toStrictEqual({ text: '"users"', params: [] });
  });

  it("doubles embedded double quotes", () => {
    expect(identifier('a"b').toSql()).toStrictEqual({ text: '"a""b"', params: [] });
  });
});

describe("join", () => {
  it("puts the separator between fragments", () => {
    const fragment = join([sql`${1}`, identifier("b"), sql`${2}`], sql`, `);
    expect(fragment.toSql()).toStrictEqual({ text: '$1, "b", $2', params: [1, 2] });
  });

  it("renders no fragments as empty text", () => {
    expect(join([], sql`, `).toSql()).toStrictEqual({ text: "", params: [] });
  });
});
