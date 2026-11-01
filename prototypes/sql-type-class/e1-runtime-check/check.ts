// Enum option E1: the class carries an enum's labels only, and the builder's column-operand path
// runs this check when it builds the predicate. It covers what a labels-only class can't: two
// enums with the same labels, and, beyond the brief, arrays and domains over an enum (both
// Postgres-checked in README.md).
import type { ColumnState } from "../../../src/runtime/definition/column.ts";

export type ColumnSide = {
  /** The column as the error names it, such as `users.mood`. */
  readonly label: string;
  readonly state: Pick<ColumnState, "sqlType" | "enumType" | "domainType" | "array">;
};

/** Postgres compares these only with the identical type: an enum, a domain over one, an array. */
function needsIdenticalType(state: ColumnSide["state"]): boolean {
  return (
    state.array || state.enumType !== undefined || state.domainType?.base.enumType !== undefined
  );
}

/** The type itself: the enum or domain object, or the SQL name without its modifiers. */
function typeOf(state: ColumnSide["state"]): unknown {
  return state.domainType ?? state.enumType ?? state.sqlType.replace(/\(.*\)$/u, "");
}

export function assertComparable(left: ColumnSide, right: ColumnSide): void {
  if (!needsIdenticalType(left.state) && !needsIdenticalType(right.state)) return;
  if (left.state.array === right.state.array && typeOf(left.state) === typeOf(right.state)) return;
  throw new Error(
    `Can't compare ${left.label} with ${right.label}: Postgres compares an enum, a domain over one, or an array only with the identical type`,
  );
}
