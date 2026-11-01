import type { ColumnState } from "../definition/index.ts";
import { quoteIdentifier } from "../internal/index.ts";

/** One side of a column-to-column comparison. */
export type ComparedColumn = {
  /** The table's alias in the statement, such as `users`. */
  readonly alias: string;
  /** The column's SQL name. */
  readonly column: string;
  readonly state: Pick<ColumnState, "sqlType" | "enumType" | "domainType" | "array">;
};

/** Postgres compares these only with the identical type: an enum, a domain over one, an array. */
function needsIdenticalType(state: ComparedColumn["state"]): boolean {
  return (
    state.array || state.enumType !== undefined || state.domainType?.base.enumType !== undefined
  );
}

/** The type itself: the domain or enum object, or the SQL name without its modifiers. */
function typeOf(state: ComparedColumn["state"]): unknown {
  return state.domainType ?? state.enumType ?? state.sqlType.replace(/\(.*\)$/u, "");
}

/**
 * Throws when Postgres has no operator for the pair, which a column's SQL type class can't tell:
 * two enums share the class `enum`, and an array's class names its element's class only.
 */
function labelOf(side: ComparedColumn): string {
  return `${quoteIdentifier(side.alias)}.${quoteIdentifier(side.column)}`;
}

export function assertComparable(left: ComparedColumn, right: ComparedColumn): void {
  if (!needsIdenticalType(left.state) && !needsIdenticalType(right.state)) return;
  if (left.state.array === right.state.array && typeOf(left.state) === typeOf(right.state)) return;
  throw new Error(
    `Can't compare ${labelOf(left)} with ${labelOf(right)}: Postgres compares an enum, a domain over one, or an array only with the identical type`,
  );
}
