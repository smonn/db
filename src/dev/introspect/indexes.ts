import { INDEX_METHODS } from "../../runtime/definition/index.ts";
import type { DriverRow } from "../../runtime/ports/index.ts";
import type { CatalogBuilder, IndexKeyPayload } from "../catalog/index.ts";

/** The column names `INDEXES` read for an index: its keys, then its INCLUDE columns. */
export function indexColumns(row: DriverRow): string[] {
  return [...texts(row["columns"]), ...texts(row["include"])];
}

export function addIndex(
  builder: CatalogBuilder,
  schema: string,
  tableName: string,
  row: DriverRow,
): void {
  const method = INDEX_METHODS.find((candidate) => candidate === row["method"]);
  if (method === undefined) {
    throw new Error(`index ${JSON.stringify(row["name"])} has an unmodeled method`);
  }
  const orders = texts(row["orders"]);
  const keys = texts(row["columns"]).map((column, at): IndexKeyPayload => ({
    column,
    descending: orders[at]?.startsWith("desc") ?? false,
    nullsFirst: orders[at]?.endsWith("first") ?? false,
  }));
  builder.index(schema, tableName, String(row["name"]), {
    unique: row["is_unique"] === true,
    method,
    keys,
    include: texts(row["include"]),
    nullsNotDistinct: row["nulls_not_distinct"] === true,
  });
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
