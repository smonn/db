import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type { Rename } from "../catalog/index.ts";
import { quoteLiteral } from "./enums.ts";

/**
 * The `RENAME` statement for one rename. A column's table, and a label's enum, are named as the
 * renames before them leave them, since the migration and the Shadow both run those first.
 */
export function renameSql(rename: Rename): string {
  const schema = quoteIdentifier(rename.schema);
  const to = quoteIdentifier(rename.name);
  if (rename.kind === "table") {
    return `alter table ${schema}.${quoteIdentifier(rename.was)} rename to ${to};`;
  }
  if (rename.kind === "column") {
    const table = `${schema}.${quoteIdentifier(rename.table)}`;
    return `alter table ${table} rename column ${quoteIdentifier(rename.was)} to ${to};`;
  }
  if (rename.kind === "enum") {
    return `alter type ${schema}.${quoteIdentifier(rename.was)} rename to ${to};`;
  }
  if (rename.kind === "enum label") {
    const type = `${schema}.${quoteIdentifier(rename.enum)}`;
    return `alter type ${type} rename value ${quoteLiteral(rename.was)} to ${quoteLiteral(rename.name)};`;
  }
  return `alter domain ${schema}.${quoteIdentifier(rename.was)} rename to ${to};`;
}
