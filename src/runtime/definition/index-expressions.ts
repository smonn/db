import { quoteIdentifier } from "../internal/index.ts";
import { inlineSql, type RenderedSql } from "../sql/index.ts";
import { columnOf, type RuntimeRefs } from "./table-keys.ts";

/** An index key or predicate written with the `sql` template, naming columns through the table's references. */
export type SqlExpression = { toSql(): RenderedSql };

type Rename = (key: string) => string;

/**
 * The expression as DDL text, each reference as its quoted column, named by `rename` (its key by
 * default), or `undefined` when `given` is no `sql` expression. DDL binds nothing, so any other
 * interpolated value throws.
 */
export function expressionOf(
  own: RuntimeRefs,
  given: unknown,
  rename: Rename = (key) => key,
): string | undefined {
  const text = inlineSql(given, (value) => {
    if (typeof value !== "object" || value === null || !("~ref" in value)) {
      throw new TypeError(
        "The table's indexes takes column references in an sql expression, not values; write a literal in the SQL text",
      );
    }
    return quoteIdentifier(rename(columnOf(own, value, "indexes")));
  });
  if (text?.trim() === "")
    throw new Error("The table's indexes takes an sql expression that is empty");
  return text?.trim();
}

/** Kept apart from the index, so its payload holds only the text the catalog compares. */
const renders = new WeakMap<object, (rename: Rename) => string | undefined>();

/**
 * Remembers the expression behind `holder`, an expression key or an index for its `where`, since
 * `defineDatabase` maps column keys to SQL names only after `defineTable` rendered it.
 */
export function rememberExpression(holder: object, own: RuntimeRefs, given: unknown): void {
  renders.set(holder, (rename) => expressionOf(own, given, rename));
}

/** The expression behind `holder` with each column named by `rename`; `undefined` when none was remembered. */
export function renamedExpression(holder: object, rename: Rename): string | undefined {
  return renders.get(holder)?.(rename);
}
