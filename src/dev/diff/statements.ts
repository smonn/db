import { quoteIdentifier } from "../../runtime/internal/index.ts";
import { childrenOf, parentOf, qualified, type Catalog, type Fact } from "../catalog/index.ts";

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

export function createTable(table: FactOf<"table">, { to }: { readonly to: Catalog }): string {
  const columns = childrenOf(to, table).flatMap((child) =>
    child.kind === "column" ? [`  ${columnDefinition(child, to)}`] : [],
  );
  const body = columns.length === 0 ? "()" : `(\n${columns.join(",\n")}\n)`;
  return `create table ${qualified(table, to)} ${body};`;
}

export function dropConstraint(
  key: FactOf<"primary key" | "unique" | "foreign key">,
  { from }: { readonly from: Catalog },
): string {
  return `${alterTable(key, from)} drop constraint ${quoteIdentifier(key.name)};`;
}

/** Leaves out the clauses at Postgres's defaults, so the statement reads like the SQL one writes. */
export function addForeignKey(
  key: FactOf<"foreign key">,
  { to }: { readonly to: Catalog },
): string {
  const { columns, target, onDelete, onUpdate, match, deferrable } = key.payload;
  const clauses = [
    match === "full" ? "match full" : "",
    onDelete === "no action" ? "" : `on delete ${onDelete}`,
    onUpdate === "no action" ? "" : `on update ${onUpdate}`,
    deferrable === "not deferrable" ? "" : `deferrable initially ${deferrable}`,
  ].filter((clause) => clause !== "");
  const references = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)} (${columnList(target.columns)})`;
  return `${alterTable(key, to)} add constraint ${quoteIdentifier(key.name)} foreign key (${columnList(columns)}) references ${[references, ...clauses].join(" ")};`;
}
