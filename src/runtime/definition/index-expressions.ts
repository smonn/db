import { quoteIdentifier } from "../internal/index.ts";
import { inlineSql, type RenderedSql } from "../sql/index.ts";
import { columnOf, type RuntimeRefs } from "./table-keys.ts";

/** An index key or predicate written with the `sql` template, naming columns through the table's references. */
export type SqlExpression = { toSql(): RenderedSql };

/**
 * The expression as DDL text, each reference as its quoted column, or `undefined` when `given` is
 * no `sql` expression. DDL binds nothing, so any other interpolated value throws.
 */
export function expressionOf(own: RuntimeRefs, given: unknown): string | undefined {
  const text = inlineSql(given, (value) => {
    if (typeof value !== "object" || value === null || !("~ref" in value)) {
      throw new TypeError(
        "The table's indexes takes column references in an sql expression, not values; write a literal in the SQL text",
      );
    }
    return quoteIdentifier(columnOf(own, value, "indexes"));
  });
  if (text?.trim() === "")
    throw new Error("The table's indexes takes an sql expression that is empty");
  return text?.trim();
}
