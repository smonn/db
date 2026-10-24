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

  it("skips an instance class field, public or private, which runs at construction", () => {
    expect(topLevelEffects("class A { x = (a = 1); y = n++; z = new Foo(); }")).toEqual([]);
    expect(topLevelEffects("class A { #x = (a = 1); #y = n++; #z = new Foo(); }")).toEqual([]);
  });

  it("flags a computed key of an instance field, which is evaluated at class definition", () => {
    expect(topLevelEffects("class A { [n++] = 1; }")).toEqual(["UpdateExpression: n++"]);
  });

  it("flags a static class field, public or private, which runs at load", () => {
    expect(topLevelEffects("class A { static x = n++; }")).toEqual(["UpdateExpression: n++"]);
    expect(topLevelEffects("class A { static #x = new Foo(); }")).toEqual([
      "NewExpression: new Foo()",
    ]);
  });

  it("allows a call or construction marked as pure, in either annotation spelling", () => {
    const source = `import { make } from "./make.mjs";
const a = /* @__PURE__ */ make();
const b = /*#__PURE__*/ new Foo();
const c = (/* @__PURE__ */ make());
`;

    expect(topLevelEffects(source)).toEqual([]);
  });

  it("still flags an effect inside the arguments of a pure call", () => {
    expect(topLevelEffects("const a = /* @__PURE__ */ make(n++);")).toEqual([
      "UpdateExpression: n++",
    ]);
  });

  it("flags a call that follows an ordinary comment rather than a pure annotation", () => {
    expect(topLevelEffects("const a = /* note */ make();")).toEqual(["CallExpression: make()"]);
    expect(topLevelEffects("const a = /* @__PURE__ */ 1, b = make();")).toEqual([
      "CallExpression: make()",
    ]);
  });

  it("flags a call to an imported function, since a static check cannot see what it does", () => {
    expect(topLevelEffects('import { join } from "node:path";\nconst p = join("a", "b");')).toEqual(
      ['CallExpression: join("a", "b")'],
    );
  });

  it("flags a tagged template, since the tag runs at load", () => {
    expect(topLevelEffects("const q = sql`select 1`;")).toEqual([
      "TaggedTemplateExpression: sql`select 1`",
    ]);
  });

  it("allows a call to a local function in an initializer but not as a statement", () => {
    expect(topLevelEffects("const f = () => 1;\nconst x = f();")).toEqual([]);
    expect(topLevelEffects("const f = () => 1;\nf();")).toEqual(["ExpressionStatement: f();"]);
  });
});
