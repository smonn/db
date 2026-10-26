import type { Column, ColumnState } from "./column.ts";
import type { Domain } from "./domain.ts";
import { type ColumnFactories, factories } from "./factories.ts";

/** The factories a domain's base comes from: every type but another domain. */
export type BaseFactories = Omit<ColumnFactories, "domain">;

export type DomainOptions<N extends boolean = boolean> = {
  /** The type's SQL name in place of its key, for a name casing can't produce. */
  readonly name?: string;
  /** Makes every column of the domain NOT NULL, and non-null in `Row`. */
  readonly notNull?: N;
  /** A SQL expression, such as `0`; a string literal needs its quotes (`"'new'"`). */
  readonly default?: string;
  /**
   * Each check's expression, keyed by its constraint name, since unnamed ones would all derive
   * `<domain>_check`. `value` names the value checked, as in `value > 0`.
   */
  readonly checks?: Readonly<Record<string, string>>;
  /** The domain's SQL name before this change; generate ignores it once the old name is gone. */
  readonly renamedFrom?: string;
};

/** Whether `.array()` or a modifier ran on the base, which belongs on the domain's columns or options. */
function modified(state: ColumnState, codec: unknown): boolean {
  return [
    state.notNull,
    state.default !== undefined,
    state.identity !== undefined,
    state.primaryKey,
    state.unique,
    state.indexes.length > 0,
    state.explicitName !== undefined,
    state.renamedFrom !== undefined,
    state.references !== undefined,
    codec !== undefined,
  ].some(Boolean);
}

/**
 * A domain over the type `define` returns, a factory type or an enum. It sits in a schema's object
 * beside its tables, named by its key, and a column takes it with `c.domain(posint)`.
 */
export function defineDomain<V, Int extends boolean, N extends boolean = false>(
  define: (c: BaseFactories) => Column<V, false, Int>,
  options: DomainOptions<N> = {},
): Domain<V, N> {
  const base = define(factories);
  const { state } = base;
  if (state.array) {
    throw new Error(
      "A domain's base can't be an array; make each column an array instead, as in c.domain(posint).array()",
    );
  }
  if (state.domainType !== undefined) throw new Error("A domain's base can't be another domain");
  if (modified(state, base["~codec"])) {
    throw new Error(
      "defineDomain takes a bare type, such as c.integer(); declare notNull, default, and checks in its options",
    );
  }
  const domain = {
    kind: "domain",
    base: { sqlType: state.sqlType, enumType: state.enumType },
    notNull: options.notNull === true,
    explicitName: options.name,
    default: options.default,
    checks: { ...options.checks },
    renamedFrom: options.renamedFrom,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- "~types" exists only in types, so `domain` doesn't overlap `Domain` enough for a direct cast (TS2352); it goes through `unknown`.
  return domain as unknown as Domain<V, N>;
}
