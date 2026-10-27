import { describe, expect, it } from "vitest";
import { type NodePath, shouldIgnore, strykerPlugins } from "./stryker-ignorer.ts";

type Node = NodePath["node"];

const PROGRAM: Node = { type: "Program" };
const BLOCK: Node = { type: "BlockStatement" };
const identifier = (name: string): Node => ({ type: "Identifier", name });
const member = (object: Node, property: Node, computed = false): Node => ({
  type: "MemberExpression",
  object,
  property,
  computed,
});
const metaProperty = (meta: string, property: string): Node => ({
  type: "MetaProperty",
  meta: identifier(meta),
  property: identifier(property),
});
const IMPORT_META = metaProperty("import", "meta");
const IMPORT_META_MAIN = member(IMPORT_META, identifier("main"));
const call = (callee: Node, type = "CallExpression"): Node => ({
  type,
  callee,
  arguments: [identifier("argv")],
});
const statement = (expression: Node): Node => ({ type: "ExpressionStatement", expression });
const MAIN_CALL = call(identifier("main"));
const MAIN_STATEMENT = statement(MAIN_CALL);
const block = (...body: Node[]): Node => ({ type: "BlockStatement", body });
const ifStatement = (
  test: Node,
  alternate: Node | null = null,
  consequent: Node = MAIN_STATEMENT,
): Node => ({ type: "IfStatement", test, consequent, alternate });
const guard = (test: Node, parent: Node | null = PROGRAM): NodePath => ({
  node: ifStatement(test),
  parent,
});
const guardRunning = (consequent: Node): NodePath => ({
  node: ifStatement(IMPORT_META_MAIN, null, consequent),
  parent: PROGRAM,
});

const property = (key: Node, value: Node, computed = false): Node => ({
  type: "ObjectProperty",
  key,
  value,
  computed,
});
const method = (name: string, computed = false): Node => ({
  type: "ObjectMethod",
  key: identifier(name),
  computed,
});
const object = (...properties: Node[]): Node => ({ type: "ObjectExpression", properties });
const META = property(identifier("meta"), object());
const CREATE = method("create");

describe("shouldIgnore", () => {
  it("ignores a top-level `if (import.meta.main)` with no else", () => {
    expect(shouldIgnore(guard(IMPORT_META_MAIN))).toMatch(
      /^Entry guard: import\.meta\.main is false under the test runner/u,
    );
  });

  it.each<[string, Node]>([
    ["a bare call", MAIN_STATEMENT],
    ["an awaited call", statement({ type: "AwaitExpression", argument: MAIN_CALL })],
    ["a call alone in a block", block(MAIN_STATEMENT)],
    [
      "an awaited call alone in a block",
      block(statement({ type: "AwaitExpression", argument: MAIN_CALL })),
    ],
  ])("ignores a guard that runs %s", (_, consequent) => {
    expect(shouldIgnore(guardRunning(consequent))).toMatch(/^Entry guard:/u);
  });

  it.each<[string, Node]>([
    ["other statements beside main", block(MAIN_STATEMENT, statement(call(identifier("cleanup"))))],
    ["other statements before main", block(statement(call(identifier("setup"))), MAIN_STATEMENT)],
    ["an empty block", block()],
    ["a block with a non-statement body", { type: "BlockStatement" }],
    ["a call to another function", statement(call(identifier("run")))],
    [
      "a call to a member named main",
      statement(call(member(identifier("app"), identifier("main")))),
    ],
    ["an optional call to main", statement(call(identifier("main"), "OptionalCallExpression"))],
    ["a bare reference to main", statement(identifier("main"))],
    [
      "an awaited reference to main",
      statement({ type: "AwaitExpression", argument: identifier("main") }),
    ],
    [
      "an awaited call to another function",
      statement({ type: "AwaitExpression", argument: call(identifier("run")) }),
    ],
    ["a non-expression statement", { type: "ReturnStatement", expression: MAIN_CALL }],
    ["no statement", { type: "EmptyStatement" }],
  ])("keeps a guard that runs %s", (_, consequent) => {
    expect(shouldIgnore(guardRunning(consequent))).toBeUndefined();
  });

  it.each<[string, NodePath]>([
    ["with an else", { node: ifStatement(IMPORT_META_MAIN, BLOCK), parent: PROGRAM }],
    [
      "as a while loop",
      { node: { type: "WhileStatement", test: IMPORT_META_MAIN }, parent: PROGRAM },
    ],
    ["nested in a block", guard(IMPORT_META_MAIN, BLOCK)],
    ["with no parent", guard(IMPORT_META_MAIN, null)],
    ["testing import.meta[main]", guard(member(IMPORT_META, identifier("main"), true))],
    ["testing import.meta?.main", guard({ ...IMPORT_META_MAIN, type: "OptionalMemberExpression" })],
    ["testing import.meta.url", guard(member(IMPORT_META, identifier("url")))],
    ["testing new.target.main", guard(member(metaProperty("new", "target"), identifier("main")))],
    [
      "testing x.meta.main",
      guard(member(member(identifier("x"), identifier("meta")), identifier("main"))),
    ],
    ["testing a bare main", guard(identifier("main"))],
  ])("keeps an import.meta.main check %s", (_, path) => {
    expect(shouldIgnore(path)).toBeUndefined();
  });

  it.each<[string, Node]>([
    ["method", CREATE],
    ["function property", property(identifier("create"), { type: "FunctionExpression" })],
    ["arrow property", property(identifier("create"), { type: "ArrowFunctionExpression" })],
  ])("ignores the meta of an object literal with a create %s", (_, create) => {
    expect(shouldIgnore({ node: META, parent: object(create, META) })).toMatch(
      /^Lint rule meta: neither RuleTester nor the rule's reports read it/u,
    );
  });

  it.each<[string, NodePath]>([
    ["beside no create", { node: META, parent: object(META, method("rules")) }],
    ["beside a computed [create]", { node: META, parent: object(META, method("create", true)) }],
    ["in a parent with no properties", { node: META, parent: PROGRAM }],
    [
      "as a computed [meta]",
      { node: property(identifier("meta"), object(), true), parent: object(CREATE) },
    ],
    ["named docs", { node: property(identifier("docs"), object()), parent: object(CREATE) }],
    [
      "set to a variable",
      { node: property(identifier("meta"), identifier("META")), parent: object(CREATE) },
    ],
    [
      "beside a create set to a variable",
      { node: META, parent: object(property(identifier("create"), identifier("someValue")), META) },
    ],
    [
      "beside a create set to a literal",
      { node: META, parent: object(property(identifier("create"), { type: "NullLiteral" }), META) },
    ],
    ["as a meta() method", { node: method("meta"), parent: object(CREATE) }],
  ])("keeps a meta %s", (_, path) => {
    expect(shouldIgnore(path)).toBeUndefined();
  });
});

it("registers shouldIgnore as the unreachable-in-tests ignorer", () => {
  expect(strykerPlugins).toEqual([
    { kind: "Ignore", name: "unreachable-in-tests", value: { shouldIgnore } },
  ]);
});
