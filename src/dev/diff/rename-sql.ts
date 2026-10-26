import { quoteIdentifier } from "../../runtime/internal/index.ts";
import type { Rename } from "../catalog/index.ts";

/**
 * The `RENAME` statement for one rename. A column's table is named as the table renames leave it,
 * since the migration and the Shadow both run every table rename first.
 */
export function renameSql(rename: Rename): string {
  const schema = quoteIdentifier(rename.schema);
  if (rename.kind === "table") {
    return `alter table ${schema}.${quoteIdentifier(rename.was)} rename to ${quoteIdentifier(rename.name)};`;
  }
  const table = `${schema}.${quoteIdentifier(rename.table)}`;
  return `alter table ${table} rename column ${quoteIdentifier(rename.was)} to ${quoteIdentifier(rename.name)};`;
}
