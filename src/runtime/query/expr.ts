import { fragment, type Fragment } from "../sql/index.ts";

/** One sort key for `orderBy`, made by `asc` or `desc`; a bare column sorts ascending. */
export type Ordering = { readonly "~ordering": () => Fragment };

type NullsOptions = { readonly nulls?: "first" | "last" };

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
