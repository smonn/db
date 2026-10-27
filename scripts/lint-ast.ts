/**
 * AST helpers the rules of `lint-plugin.ts` share. A type check that only narrows for TypeScript,
 * such as `object.type === "Identifier"` before reading `object.name`, changes nothing at runtime
 * when dropped, so mutation testing can never kill it. These helpers hold each such check once,
 * where some rule's test can tell it apart, and `field` reads what only one node type carries.
 */
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>["create"]>[0];
type Node = Parameters<Context["sourceCode"]["getScope"]>[0];

/** Whether `node` is an identifier whose name passes `test`; a private `#name` is not one. */
export function isIdentifier(node: Node, test: (name: string) => boolean): boolean {
  return node.type === "Identifier" && test(node.name);
}

/** Whether `node` is `object.property`, not `object[property]`, with each name passing its test. */
export function isMember(
  node: Node,
  object: (name: string) => boolean,
  property: (name: string) => boolean,
): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    isIdentifier(node.object, object) &&
    isIdentifier(node.property, property)
  );
}

export const named =
  (expected: string) =>
  (name: string): boolean =>
    name === expected;

/** A field of `node`, or undefined on a node type that lacks it. */
export function field(node: Node, key: string): unknown {
  return Reflect.get(node, key);
}
