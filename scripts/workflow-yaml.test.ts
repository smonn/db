import { describe, expect, test } from "vitest";
import { workflowYamlProblems } from "./workflow-yaml.ts";

const problems = (text: string): string[] => workflowYamlProblems(text, "w.yml");
const unreadable = (line: number, form: string): string =>
  `w.yml line ${line} uses ${form}, which this check can't read`;
const permissionsForm =
  'write permissions as {}, read-all, write-all, a one-line flow map, or one "scope: level" per line';
const broken = (line: number): string =>
  `w.yml line ${line} breaks a permissions block; ${permissionsForm}`;

describe("workflowYamlProblems", () => {
  test.each([
    ["flow sequences", "on:\n  push:\n    branches: [main, 'release/*', \"v1\"]\n"],
    ["a permissions word in a flow sequence", "x: [permissions, {a: [permissions]}]\n"],
    ["a flow map with an empty value", "x: {a: , b: [c, {d: e}]}\n"],
    ["comments", "# top\nname: CI # trailing\nx: 'a # b' # c\n"],
    ["expressions and URLs", "group: ${{ github.ref }}-x\nimage: docker://alpine:3.20\n"],
    ["a doubled single quote", "if: 'it''s'\n"],
    ["a sequence of scalars", 'ports:\n  - 5432:5432\n  - "a"\n  -\n'],
    ["a plain scalar across lines", "if: a ||\n  b\n"],
    ["a quoted key", '"run": echo\n'],
    [
      "block scalar content that looks like YAML",
      'steps:\n  - run: |\n      ? x\n      a: &b *c !d\n\n      "\\e"\n  - run: >-\n      permissions: x\n',
    ],
    ["a block scalar in a sequence", "- |\n  ? x\n"],
    ["permissions: {}", "permissions: {}\n"],
    ["read-all", "permissions: 'read-all'\n"],
    ["a one-line flow map", "permissions: { contents: read, \"id-token\": 'write' }\n"],
    ["one scope per line", "permissions:\n  contents: read # why\n  'id-token': \"write\"\nx: y\n"],
  ])("accepts %s", (_name, text) => {
    expect(problems(text)).toEqual([]);
  });

  test.each([
    ["an explicit key (?)", "? a\n: b\n"],
    ["an anchor (&)", "a: &x b\n"],
    ["an alias (*)", "- *x\n"],
    ["a tag (!)", "!!map a: b\n"],
    ["an alias (*)", "a: [b, *c]\n"],
    ["an escape in a double-quoted scalar", 'a: "\\x41"\n'],
    ["an escape in a double-quoted scalar", '"\\x61": b\n'],
    ["a quoted scalar across lines", "a: 'b\n  c'\n"],
    ["a quoted scalar across lines", 'a: "b\n'],
    ["a flow collection across lines", "a: [b,\n  c]\n"],
    ["a flow collection across lines", "a: {b: c # d\n  }\n"],
    ["a flow collection across lines", "a: {b:\n"],
    ["a malformed flow collection", "a: {b: c: d}\n"],
    ["text after a quoted scalar", "a: 'b' c\n"],
    ["text after a flow collection", "a: [b] c\n"],
    ["text after a flow collection", "a: {b: c} d\n"],
    ["a block scalar header", "a: |x\n"],
    ["a document marker or directive", "---\na: b\n"],
    ["a document marker or directive", "%YAML 1.2\n"],
  ])("refuses %s", (form, text) => {
    expect(problems(text)).toEqual([unreadable(1, form)]);
  });

  test("checks the line that ends a block scalar", () => {
    expect(problems("a: |\n  b\nc: &d e\n")).toEqual([unreadable(3, "an anchor (&)")]);
  });

  test.each([
    ["a tab", "a:\tb\n", "0009"],
    ["a carriage return", "a: b\r\n", "000D"],
    ["a non-breaking space in a block scalar", "a: |\n  \u00A0#b\n", "00A0", 2],
    ["a next line character", "a: b\u0085c: d\n", "0085"],
  ])("refuses %s", (_name, text, code, line = 1) => {
    expect(problems(text)).toEqual([
      `w.yml line ${line} holds U+${code}, outside printable ASCII; this check reads printable ASCII only`,
    ]);
  });

  test.each([
    ["a value on the next line", "permissions:\n  id-token:\n    write\n", 2],
    ["no scopes", "permissions:\nx: y\n", 1],
    ["a sequence", "permissions:\n  - id-token: write\n", 2],
    ["uneven indents", "permissions:\n    contents: read\n  id-token: write\n", 3],
    ["a level other than read, write, or none", "permissions:\n  id-token: admin\n", 2],
    ["a block scalar level", "permissions:\n  id-token: |\n    write\n", 2],
    ["a scalar other than read-all or write-all", "permissions: write\n", 1],
    ["a flow map with a bad entry", "permissions: { id-token: maybe }\n", 1],
    ["a flow sequence", "permissions: [id-token]\n", 1],
    ["an uppercase scope under an uppercase key", "Permissions:\n  ID-TOKEN: write\n", 2],
  ])("refuses permissions written as %s", (_name, text, line) => {
    expect(problems(text)).toEqual([broken(line)]);
  });

  test.each([
    "jobs:\n  pack: { 'PERMISSIONS': { id-token: write } }\n",
    "jobs:\n  - { permissions: { id-token: write } }\n",
    "jobs:\n  pack: { runs-on: ubuntu-24.04, permissions, steps: [{ run: echo }] }\n",
    "jobs:\n  pack: { 'permissions' , x: y }\n",
    "jobs:\n  pack: { permissions }\n",
  ])("refuses permissions inside a flow map in %j", (text) => {
    expect(problems(text)).toEqual([
      `w.yml line 2 sets permissions inside a flow map; ${permissionsForm}`,
    ]);
  });

  test("reports each line it can't read", () => {
    expect(problems("a: &b c\nd: *e\n")).toEqual([
      unreadable(1, "an anchor (&)"),
      unreadable(2, "an alias (*)"),
    ]);
  });
});
