import { describe, expect, it } from "vitest";
import { fragment, identifier, inlineSql, join } from "./sql.ts";

describe("inlineSql", () => {
  it("replaces each value, nested ones included, with what the callback returns", () => {
    const built = fragment`a = ${1} and ${fragment`b = ${2}`}`;

    expect(inlineSql(built, (value) => `<${String(value)}>`)).toBe("a = <1> and b = <2>");
  });

  it("is undefined for anything but a fragment", () => {
    expect(inlineSql("a = 1", String)).toBeUndefined();
    expect(inlineSql({ toSql: () => ({ text: "a", params: [] }) }, String)).toBeUndefined();
  });
});

describe("fragment", () => {
  it("renders text without params", () => {
    expect(fragment`select 1`.toSql()).toStrictEqual({ text: "select 1", params: [] });
  });

  it("binds each value to a numbered placeholder", () => {
    const built = fragment`select ${1}::int + ${"2"}::int, ${null}`;
    expect(built.toSql()).toStrictEqual({
      text: "select $1::int + $2::int, $3",
      params: [1, "2", null],
    });
  });

  it("inlines a nested fragment and renumbers its params", () => {
    const filter = fragment`n > ${5}`;
    const built = fragment`select ${"a"} from t where ${filter} and m = ${6}`;
    expect(built.toSql()).toStrictEqual({
      text: "select $1 from t where n > $2 and m = $3",
      params: ["a", 5, 6],
    });
  });

  it("inlines a fragment that starts and ends with a value", () => {
    const inner = fragment`${1}${2}`;
    expect(fragment`(${inner})`.toSql()).toStrictEqual({ text: "($1$2)", params: [1, 2] });
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
    const built = join([fragment`${1}`, identifier("b"), fragment`${2}`], fragment`, `);
    expect(built.toSql()).toStrictEqual({ text: '$1, "b", $2', params: [1, 2] });
  });

  it("renders no fragments as empty text", () => {
    expect(join([], fragment`, `).toSql()).toStrictEqual({ text: "", params: [] });
  });
});
