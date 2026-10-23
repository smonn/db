import { describe, expect, it } from "vitest";
import { topLevelEffects } from "./top-level-effects.test-helper.ts";

describe("topLevelEffects", () => {
  it("allows declarations, named imports, exports, and pure constructors", () => {
    const source = `import { a } from "./a.mjs";
function make() { return new Foo(); }
const cache = new Map();
export const RULES = { drop: make() };
export { a };
class Box { run() { counter++; } }
`;

    expect(topLevelEffects(source)).toEqual([]);
  });

  it("reports the source of a flagged node", () => {
    expect(topLevelEffects("const x = new Foo(1, 2);")).toEqual(["NewExpression: new Foo(1, 2)"]);
  });

  it("cuts a long snippet to about 80 characters", () => {
    const [found] = topLevelEffects(`const x = new Foo("${"a".repeat(200)}");`);

    expect(found).toHaveLength("NewExpression: ".length + 80);
    expect(found).toMatch(/\.\.\.$/u);
  });

  it("locates snippets in a second parse of the same process", () => {
    topLevelEffects("const first = new Foo();");

    expect(topLevelEffects("const second = new Bar();")).toEqual(["NewExpression: new Bar()"]);
  });

  it("flags an assignment in an initializer", () => {
    expect(topLevelEffects("const d = (globalThis.x = 1);")).toEqual([
      "AssignmentExpression: globalThis.x = 1",
    ]);
  });

  it("flags an update expression", () => {
    expect(topLevelEffects("let n = 0;\nconst d = n++;")).toEqual(["UpdateExpression: n++"]);
  });

  it("flags a delete", () => {
    expect(topLevelEffects("const d = delete globalThis.x;")).toEqual([
      "UnaryExpression: delete globalThis.x",
    ]);
  });

  it("flags a class static block", () => {
    expect(topLevelEffects("class A { static { init(); } }")).toContain(
      "StaticBlock: static { init(); }",
    );
  });

  it("flags an expression statement nested in an if, for, while, or block", () => {
    for (const source of ["if (a) { b; }", "for (;;) { b; }", "while (a) { b; }", "{ b; }"]) {
      expect(topLevelEffects(source)).toContain("ExpressionStatement: b;");
    }
  });

  it("flags a bare side-effect import but not a named one", () => {
    expect(topLevelEffects('import "./polyfill.mjs";')).toEqual([
      'ImportDeclaration: import "./polyfill.mjs";',
    ]);
    expect(topLevelEffects('import { a } from "./a.mjs";')).toEqual([]);
  });

  it("allows a call to a local function in an initializer but not as a statement", () => {
    expect(topLevelEffects("const f = () => 1;\nconst x = f();")).toEqual([]);
    expect(topLevelEffects("const f = () => 1;\nf();")).toEqual(["ExpressionStatement: f();"]);
  });
});
