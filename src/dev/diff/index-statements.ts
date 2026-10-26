import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { parentOf, qualified, type Catalog, type IndexKeyPayload } from "../catalog/index.ts";
import { columnList, type FactOf } from "./statements.ts";

/** Leaves out the clauses at Postgres's defaults, so the statement reads like the SQL one writes. */
export function createIndex(index: FactOf<"index">, to: Catalog): string {
  const { unique, method, keys, include, nullsNotDistinct } = index.payload;
  const parts = [
    unique ? "create unique index" : "create index",
    quoteIdentifier(index.name),
    "on",
    qualified(parentOf(to, index), to),
    method === "btree" ? "" : `using ${method}`,
    `(${keys.map((key) => indexKey(key)).join(", ")})`,
    include.length === 0 ? "" : `include (${columnList(include)})`,
    nullsNotDistinct ? "nulls not distinct" : "",
  ];
  return `${parts.filter((part) => part !== "").join(" ")};`;
}

/** NULLs sort last in an ascending key and first in a descending one, so only the other way is spelled. */
function indexKey({ column, descending, nullsFirst }: IndexKeyPayload): string {
  const nulls = nullsFirst === descending ? "" : ` nulls ${nullsFirst ? "first" : "last"}`;
  return `${quoteIdentifier(column)}${descending ? " desc" : ""}${nulls}`;
}

/** An index lives in its table's schema, and `drop index` names it there. */
export function dropIndex(index: FactOf<"index">, { from }: { readonly from: Catalog }): string {
  const schema = parentOf(from, parentOf(from, index));
  return `drop index ${quoteIdentifier(schema.name)}.${quoteIdentifier(index.name)};`;
}
