import { fragment, type Fragment } from "../sql/index.ts";

/** One sort key for `orderBy`, made by `asc` or `desc`; a bare column sorts ascending. */
export type Ordering = { readonly "~ordering": () => Fragment };

/**
 * The forbidding key lets a NOT NULL `Sortable` stand in for a nullable one, so `Expr<boolean>`
 * passes for `Expr<boolean | null>`: two option types with no key in common never match.
 */
type NullsOptions = {
  readonly nulls?: "first" | "last";
  readonly "nulls needs a nullable column"?: never;
};

/** A NOT NULL column has no NULLs to place, so its options type names `nulls` in the error. */
export type Sortable<V> = null extends V
  ? {
      asc(options?: NullsOptions): Ordering;
      desc(options?: NullsOptions): Ordering;
    }
  : {
      asc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
      desc(options?: { readonly "nulls needs a nullable column"?: never }): Ordering;
    };

function nullsOf(options: NullsOptions | undefined): Fragment {
  if (options === undefined) return fragment``;
  const unknown = Object.keys(options).filter((key) => key !== "nulls");
  if (unknown.length > 0) {
    throw new Error(`Unknown ordering option ${unknown.map((key) => `"${key}"`).join(", ")}`);
  }
  const { nulls } = options;
  if (nulls === undefined) return fragment``;
  if (nulls === "first") return fragment` nulls first`;
  if (nulls === "last") return fragment` nulls last`;
  throw new Error(`nulls must be "first" or "last", got ${JSON.stringify(nulls)}`);
}

/** `asc` and `desc` of what `sortKey` renders. */
export function sortable(sortKey: () => Fragment): Sortable<null> {
  const order = (direction: Fragment, options: NullsOptions | undefined): Ordering => {
    const nulls = nullsOf(options);
    return { "~ordering": () => fragment`${sortKey()} ${direction}${nulls}` };
  };
  return {
    asc: (options) => order(fragment`asc`, options),
    desc: (options) => order(fragment`desc`, options),
  };
}

/**
 * An SQL expression whose value is a `V`: a column comparison, `and`, `or`, `not`, or a
 * `` sql.expr<V>`...` `` fragment. It renders when its statement does, so a codec that throws
 * rejects the query instead of the builder.
 */
export type Expr<V = unknown> = Sortable<V> & {
  readonly "~expr": () => Fragment;
  /** Type-only: the value the expression yields. */
  readonly "~value": V;
};

const exprs = new WeakSet<object>();

/** A hand-written fragment may hold any operator, so a term of `and` or `or` wraps it in parentheses. */
const handWritten = new WeakSet<object>();

export function expr<V>(render: () => Fragment): Expr<V> {
  const made = { "~expr": render, ...sortable(render) };
  exprs.add(made);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `~value` exists only in types.
  return made as unknown as Expr<V>;
}

export function writtenExpr<V>(render: () => Fragment): Expr<V> {
  const made = expr<V>(render);
  handWritten.add(made);
  return made;
}

export function isExpr(value: unknown): value is Expr {
  return typeof value === "object" && value !== null && exprs.has(value);
}

/** `term` as one operand of `and` or `or`. */
export function termOf(term: Expr): Fragment {
  return handWritten.has(term) ? fragment`(${term["~expr"]()})` : term["~expr"]();
}
