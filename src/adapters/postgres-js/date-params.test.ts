import { describe, expect, it } from "vitest";
import { bindDateParams } from "./date-params.ts";

const at = new Date("2026-01-01T00:00:00Z");
const atText = "2026-01-01 00:00:00.000+00";

describe("bindDateParams", () => {
  it("sends a Date as UTC text and leaves other params alone", () => {
    expect(bindDateParams("select $1, $2, $3", [at, 7, "x"])).toStrictEqual({
      text: "select $1, $2, $3",
      values: [atText, 7, "x"],
    });
  });

  it("sends an array of Dates as a Postgres array literal", () => {
    const later = new Date("-000043-03-15T12:00:00.500Z");
    expect(bindDateParams("select $1", [[at, null, later]]).values).toStrictEqual([
      `{"${atText}",NULL,"0044-03-15 12:00:00.500+00 BC"}`,
    ]);
  });

  it("writes nested arrays of Dates with nested braces", () => {
    expect(bindDateParams("select $1", [[[at], [at]]]).values).toStrictEqual([
      `{{"${atText}"},{"${atText}"}}`,
    ]);
  });

  it("leaves an array with no Date for postgres.js", () => {
    const params = [[1, 2], [], [null], ["a"]];
    expect(bindDateParams("select $1, $2, $3, $4", params).values).toStrictEqual(params);
  });

  it("refuses an array that mixes Dates with other values, naming the param", () => {
    expect(() => bindDateParams("select $1, $2", [1, [at, "x"]])).toThrow(
      "Param $2 mixes Dates with other values in an array",
    );
  });

  it("gives each use of a Date param its own param, so each use deduces its own type", () => {
    expect(bindDateParams("where ts >= $1 and tz <= $1 and n = $2", [at, 1])).toStrictEqual({
      text: "where ts >= $1 and tz <= $3 and n = $2",
      values: [atText, 1, atText],
    });
  });

  it("gives each use of a Date array param its own param", () => {
    const { text, values } = bindDateParams("= any($1) or $1 = x", [[at]]);
    expect(text).toBe("= any($1) or $2 = x");
    expect(values).toStrictEqual([`{"${atText}"}`, `{"${atText}"}`]);
  });

  it("repeats a param that is not a Date as it is", () => {
    expect(bindDateParams("$1 or $1", ["x"])).toStrictEqual({
      text: "$1 or $1",
      values: ["x"],
    });
  });

  it("numbers extra params past the last one, once per extra use", () => {
    const { text, values } = bindDateParams("$1 $2 $1 $2 $1", [at, at]);
    expect(text).toBe("$1 $2 $3 $4 $5");
    expect(values).toHaveLength(5);
  });

  it("reads `$1` inside a string, quoted name, comment, or dollar quote as text", () => {
    const sql = [
      "select '$1', E'it\\'s $1', 'it''s $1'",
      '"$1"',
      "-- $1",
      "/* $1 /* $1 */ $1 */",
      "$$ $1 $$",
      "$tag$ $1 $tag$",
      "$1 $1",
    ].join("\n");
    const { text } = bindDateParams(sql, [at]);
    expect(text).toBe(sql.replace(/\$1 \$1$/u, "$1 $2"));
  });

  it("does not read a name that ends in `$1` as a param", () => {
    const sql = "select foo$1, $1, $1";
    expect(bindDateParams(sql, [at]).text).toBe("select foo$1, $1, $2");
  });

  it("leaves a `$n` past the params for Postgres to refuse", () => {
    expect(bindDateParams("select $2, $2", [at]).text).toBe("select $2, $2");
    expect(bindDateParams("select $2, $1, $1", [at])).toStrictEqual({
      text: "select $2, $1, $1",
      values: [atText],
    });
  });

  it("does not take `$12` for `$1`", () => {
    expect(bindDateParams("select $12, $1", [at]).text).toBe("select $12, $1");
  });

  it("reads `--` inside a string as text, not a comment", () => {
    expect(bindDateParams("'-- ' $1 $1", [at]).text).toBe("'-- ' $1 $2");
  });

  it("ends an `E` string at a quote after an escaped backslash", () => {
    expect(bindDateParams("E'a\\\\' $1 $1", [at]).text).toBe("E'a\\\\' $1 $2");
    expect(bindDateParams("E'a\\' $1' $1 $1", [at]).text).toBe("E'a\\' $1' $1 $2");
  });

  it("closes a tagged dollar quote at its own tag, not at a nested one", () => {
    const sql = "$a$ $b$ $1 $b$ $1 $a$";
    expect(bindDateParams(sql, [at]).text).toBe(sql);
    expect(bindDateParams(`${sql} $1 $1`, [at]).text).toBe(`${sql} $1 $2`);
  });

  it("numbers extra uses past a `$10` Date param", () => {
    const params = [at, 1, 1, 1, 1, 1, 1, 1, 1, at];
    const { text, values } = bindDateParams("$10 $1 $1", params);
    expect(text).toBe("$10 $1 $11");
    expect(values).toHaveLength(11);
    expect(bindDateParams("$10 $10 $1", params).text).toBe("$10 $11 $1");
  });

  it("reads an unterminated block comment or dollar quote to the end as text", () => {
    expect(bindDateParams("$1 /* $1 $1", [at]).text).toBe("$1 /* $1 $1");
    expect(bindDateParams("$1 $x$ $1 $1", [at]).text).toBe("$1 $x$ $1 $1");
  });

  it("reads an unterminated string as a lone quote and keeps scanning", () => {
    expect(bindDateParams("$1 ' $1 $1", [at]).text).toBe("$1 ' $2 $3");
  });
});
