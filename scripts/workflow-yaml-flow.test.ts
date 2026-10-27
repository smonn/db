import { describe, expect, test } from "vitest";
import {
  endsLine,
  flowEnd,
  indentOf,
  quotedEnd,
  refuseNodeStart,
  refuseTrailing,
  skipSpaces,
  Unreadable,
} from "./workflow-yaml-flow.ts";

const keysOf = (text: string): { end: number; keys: string[] } => {
  const keys: string[] = [];
  return { end: flowEnd(text, 0, keys), keys };
};

describe("quotedEnd", () => {
  test.each([
    ["a double-quoted scalar", '"ab" c', 4],
    ["a single-quoted scalar", "'ab' c", 4],
    ["a backslash in single quotes", "'a\\b' c", 5],
    ["a doubled single quote", "'it''s' c", 7],
    ["a single quote after a double-quoted scalar", `"a"'`, 3],
    ["an empty scalar", "'' c", 2],
  ])("ends %s", (_name, text, end) => {
    expect(quotedEnd(text, 0)).toBe(end);
  });

  test("starts at the given column", () => {
    expect(quotedEnd('x: "y"', 3)).toBe(6);
  });

  test.each([
    ["an escape in a double-quoted scalar", '"a\\n"'],
    ["a quoted scalar across lines", '"a'],
    ["a quoted scalar across lines", "'a"],
    ["a quoted scalar across lines", "'a'' "],
    ["a quoted scalar across lines", '"'],
  ])("refuses %s", (message, text) => {
    expect(() => quotedEnd(text, 0)).toThrow(new Unreadable(message));
  });
});

describe("flowEnd", () => {
  test.each([
    ["an empty map", "{} x", 2],
    ["an empty sequence", "[] x", 2],
    ["spaces inside", "{ a: b } x", 8],
    ["a plain scalar with a hash and no space before it", "[a#b] x", 5],
    ["a colon inside a plain scalar", "[a:b] x", 5],
    ["a quoted scalar holding stop characters", "['a,]b', \"c: d\"] x", 16],
    ["an empty value", "{a: , b: [c]} x", 13],
    ["a nested collection", "{a: {b: [c, d]}} x", 16],
  ])("ends after %s", (_name, text, end) => {
    expect(flowEnd(text, 0, [])).toBe(end);
  });

  test("starts at the given column", () => {
    expect(flowEnd("x: [a]", 3, [])).toBe(6);
  });

  test.each([
    ["a key with a value", "{a: b}", ["a"]],
    ["a key with no value", "{a}", ["a"]],
    ["bare keys", "{a, b}", ["a", "b"]],
    ["a key with spaces", "{a b: c}", ["a b"]],
    ["double-quoted keys", '{"a, b": c, "d": e}', ["a, b", "d"]],
    ["single-quoted keys", "{'a: b': c, 'd'}", ["a: b", "d"]],
    ["keys in nested maps", "{a: {b: [c, {d: e}]}}", ["a", "b", "d"]],
    ["a key before an empty value", "{a: , b: c}", ["a", "b"]],
    ["a key before a nested map", "{a: {}}", ["a"]],
    ["plain keys that end in a quote", "{a': b, a\": c}", ["a'", 'a"']],
    ["a sequence of scalars", "[a, b]", []],
    ["a sequence of quoted scalars", "['a', \"b\"]", []],
    ["a map in a sequence", "[{a: b}, c]", ["a"]],
    ["a pair in a sequence", "[a: b, c]", ["a"]],
  ])("collects the keys of %s", (_name, text, keys) => {
    expect(keysOf(text).keys).toEqual(keys);
  });

  test.each([
    ["an unclosed map", "{a"],
    ["an unclosed map", "{"],
    ["an unclosed map", "{ "],
    ["an unclosed map", "{a,"],
    ["an unclosed map", "{a:"],
    ["an unclosed map", "{a: "],
    ["an unclosed map", "{a: b, "],
    ["a comment after a colon", "{a: #x, b: c}"],
    ["a comment in place of an entry", "{ #x, a: b}"],
    ["a comment after an entry", "{a: b #x\n}"],
  ])("refuses %s with a flow collection across lines", (_name, text) => {
    expect(() => flowEnd(text, 0, [])).toThrow(new Unreadable("a flow collection across lines"));
  });

  test.each([
    ["two values", "{a: b: c}"],
    ["a mismatched close", "{a]"],
    ["a mismatched close", "[a}"],
    ["text after a quoted key", '{"a" b}'],
  ])("refuses %s as malformed", (_name, text) => {
    expect(() => flowEnd(text, 0, [])).toThrow(new Unreadable("a malformed flow collection"));
  });

  test("refuses an anchor, alias, or tag in a node", () => {
    expect(() => flowEnd("[&a b]", 0, [])).toThrow(new Unreadable("an anchor (&)"));
    expect(() => flowEnd("{a: *b}", 0, [])).toThrow(new Unreadable("an alias (*)"));
    expect(() => flowEnd("[!a b]", 0, [])).toThrow(new Unreadable("a tag (!)"));
    expect(() => flowEnd("[?a]", 0, [])).toThrow(new Unreadable("an explicit key (?)"));
  });
});

describe("line helpers", () => {
  test("indentOf counts leading whitespace", () => {
    expect(indentOf("   a ")).toBe(3);
    expect(indentOf("a")).toBe(0);
  });

  test("skipSpaces skips only spaces", () => {
    expect(skipSpaces("a  b", 1)).toBe(3);
    expect(skipSpaces("a\tb", 1)).toBe(1);
    expect(skipSpaces("a  ", 1)).toBe(3);
  });

  test("endsLine is true at the end of the text or a hash", () => {
    expect(endsLine("ab", 2)).toBe(true);
    expect(endsLine("ab", 3)).toBe(true);
    expect(endsLine("a #", 2)).toBe(true);
    expect(endsLine("ab", 1)).toBe(false);
  });

  test("refuseNodeStart accepts an ordinary character and the end of the text", () => {
    expect(() => {
      refuseNodeStart("a", 0);
    }).not.toThrow();
    expect(() => {
      refuseNodeStart("a", 1);
    }).not.toThrow();
  });

  test("refuseTrailing allows spaces and a comment after a node", () => {
    expect(() => {
      refuseTrailing("[a]  # c", 3, "a flow collection");
    }).not.toThrow();
    expect(() => {
      refuseTrailing("[a]", 3, "a flow collection");
    }).not.toThrow();
    expect(() => {
      refuseTrailing("[a] b", 3, "a flow collection");
    }).toThrow(new Unreadable("text after a flow collection"));
  });
});
