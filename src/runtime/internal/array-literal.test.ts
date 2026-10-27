import { describe, expect, it } from "vitest";
import { elementText, formatArrayLiteral, parseArrayLiteral } from "./array-literal.ts";

const text = (value: string): string => value;

describe("parseArrayLiteral", () => {
  it("reads an empty array", () => {
    expect(parseArrayLiteral("{}", text)).toStrictEqual([]);
  });

  it("reads an unquoted NULL as null and a quoted one as text", () => {
    expect(parseArrayLiteral('{a,NULL,"NULL",null}', text)).toStrictEqual([
      "a",
      null,
      "NULL",
      null,
    ]);
  });

  it("hands each non-NULL element to the element parser", () => {
    expect(parseArrayLiteral("{1,NULL,3}", BigInt)).toStrictEqual([1n, null, 3n]);
  });

  it("reads quoted elements with escapes, delimiters, braces, and spaces", () => {
    expect(parseArrayLiteral(String.raw`{"a,b","{c}"," d ","e\"f","g\\h",""}`, text)).toStrictEqual(
      ["a,b", "{c}", " d ", 'e"f', String.raw`g\h`, ""],
    );
  });

  it("reads nested arrays", () => {
    expect(parseArrayLiteral("{{1,2},{NULL,4}}", Number)).toStrictEqual([
      [1, 2],
      [null, 4],
    ]);
  });

  it("skips the bounds Postgres writes for a lower bound other than 1", () => {
    expect(parseArrayLiteral("[0:1]={a,b}", text)).toStrictEqual(["a", "b"]);
  });

  it("splits on the delimiter it is given", () => {
    expect(parseArrayLiteral("{(1,1),(0,0);(2,2),(1,1)}", text, ";")).toStrictEqual([
      "(1,1),(0,0)",
      "(2,2),(1,1)",
    ]);
  });

  it.each(["", "a", "{a", "{a}b", '{"a}', "{a,}", "{{a}"])("refuses %j, naming it", (literal) => {
    expect(() => parseArrayLiteral(literal, text)).toThrow(
      `Can't read array ${JSON.stringify(literal)}`,
    );
  });
});

describe("formatArrayLiteral", () => {
  it("writes an empty array", () => {
    expect(formatArrayLiteral([])).toBe("{}");
  });

  it("quotes every element and writes null as NULL", () => {
    expect(formatArrayLiteral(["NULL", null, 'a"b\\c', "x,y"])).toBe(
      String.raw`{"NULL",NULL,"a\"b\\c","x,y"}`,
    );
  });

  it("writes nested arrays", () => {
    expect(
      formatArrayLiteral([
        [1, null],
        [3, 4],
      ]),
    ).toBe('{{"1",NULL},{"3","4"}}');
  });

  it("formats elements with the function it is given", () => {
    expect(formatArrayLiteral([{ a: 1 }, null], JSON.stringify)).toBe(
      String.raw`{"{\"a\":1}",NULL}`,
    );
  });

  it("joins with the delimiter it is given", () => {
    expect(formatArrayLiteral(["a", "b"], elementText, ";")).toBe('{"a";"b"}');
  });

  it("refuses an undefined element", () => {
    expect(() => formatArrayLiteral(["a", undefined])).toThrow("An array element is undefined");
  });

  it("round-trips through parseArrayLiteral", () => {
    const value = [
      ["a", null, 'q"'],
      ["\\", "", "NULL"],
    ];
    expect(parseArrayLiteral(formatArrayLiteral(value), text)).toStrictEqual(value);
  });
});

describe("elementText", () => {
  it.each([
    ["a string as itself", "héllo", "héllo"],
    ["a number", 1.5, "1.5"],
    ["a bigint", 9007199254740993n, "9007199254740993"],
    ["true", true, "t"],
    ["false", false, "f"],
    [
      "a Date as UTC timestamp text",
      new Date("2026-01-01T00:00:00Z"),
      "2026-01-01 00:00:00.000+00",
    ],
    ["bytes as hex", Uint8Array.of(0, 255, 16), String.raw`\x00ff10`],
    ["an object as JSON", { a: [1] }, '{"a":[1]}'],
  ])("writes %s", (_, value, expected) => {
    expect(elementText(value)).toBe(expected);
  });

  it("refuses a value that has no text, naming its type", () => {
    expect(() => elementText(Symbol("s"))).toThrow("An array element is a symbol");
  });

  it("refuses an Invalid Date", () => {
    expect(() => elementText(new Date(Number.NaN))).toThrow("An array element is an Invalid Date");
  });
});
