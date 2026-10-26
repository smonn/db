import { quoteIdentifier } from "../../runtime/internal/index.ts";
import {
  childrenOf,
  parentOf,
  qualified,
  type Catalog,
  type Fact,
  type IndexKeyPayload,
} from "../catalog/index.ts";

export type FactOf<K extends Fact["kind"]> = Extract<Fact, { readonly kind: K }>;

export function columnDefinition(column: FactOf<"column">, to: Catalog): string {
  const { type, notNull } = column.payload;
  const parts = [quoteIdentifier(column.name), type];
  if (notNull) parts.push("not null");
  for (const child of childrenOf(to, column)) {
    if (child.kind === "identity") parts.push(identityClause(child));
    if (child.kind === "default") parts.push(`default ${defaultClause(child)}`);
    if (child.kind === "generated") {
      parts.push(`generated always as (${child.payload.expression}) ${child.payload.storage}`);
    }
  }
  return parts.join(" ");
}

export function addConstraint(
  key: FactOf<"primary key" | "unique">,
  clause: string,
  columns: readonly string[],
  to: Catalog,
): string {
  return `${alterTable(key, to)} add constraint ${quoteIdentifier(key.name)} ${clause} (${columnList(columns)});`;
}

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

export function columnList(names: readonly string[]): string {
  return names.map((name) => quoteIdentifier(name)).join(", ");
}

/** `alter table` for the table that holds `fact`, a column or key. */
export function alterTable(fact: Fact, catalog: Catalog): string {
  return `alter table ${qualified(parentOf(catalog, fact), catalog)}`;
}

/** `alter column` for `fact`, a column or one of its attributes. */
export function alterColumn(
  fact: FactOf<"column" | "default" | "identity" | "generated">,
  catalog: Catalog,
): string {
  const column = fact.kind === "column" ? fact : parentOf(catalog, fact);
  return `${alterTable(column, catalog)} alter column ${quoteIdentifier(column.name)}`;
}

export function identityClause(identity: FactOf<"identity">): string {
  return `generated ${identity.payload.generated} as identity`;
}

/** Parenthesized, so any expression the Definition writes parses as a default. */
export function defaultClause(fact: FactOf<"default">): string {
  return `(${fact.payload.expression})`;
}
