import { INDEX_METHODS } from "../../runtime/definition/index.ts";
import type { DriverRow } from "../../runtime/ports/index.ts";
import type { CatalogBuilder, IndexKeyPayload } from "../catalog/index.ts";

/** The column names `INDEXES` read for an index: its plain keys, then its INCLUDE columns. */
export function indexColumns(row: DriverRow): string[] {
  return [
    ...nullableTexts(row["columns"]).filter((column) => column !== null),
    ...texts(row["include"]),
  ];
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
  const expressions = nullableTexts(row["expressions"]);
  const keys = nullableTexts(row["columns"]).map((column, at) =>
    keyOf(column, expressions[at], orders[at]),
  );
  builder.index(schema, tableName, String(row["name"]), {
    unique: row["is_unique"] === true,
    method,
    keys,
    include: texts(row["include"]),
    where: typeof row["predicate"] === "string" ? row["predicate"] : undefined,
    nullsNotDistinct: row["nulls_not_distinct"] === true,
  });
}

function keyOf(
  column: string | null,
  expression: string | null | undefined,
  order: string | undefined,
): IndexKeyPayload {
  const descending = order?.startsWith("desc") === true;
  const nullsFirst = order?.endsWith("first") === true;
  if (column !== null) return { column, descending, nullsFirst };
  return { expression: bare(expression ?? undefined), descending, nullsFirst };
}

/**
 * `pg_get_indexdef` wraps an expression key that isn't a bare function call in parentheses; a
 * function call never starts with one. The payload holds the expression alone.
 */
function bare(deparsed: string | undefined): string {
  if (deparsed === undefined) {
    throw new Error("an index key has neither a column nor an expression");
  }
  return deparsed.startsWith("(") ? deparsed.slice(1, -1) : deparsed;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nullableTexts(value: unknown): (string | null)[] {
  return Array.isArray(value) ? value.map((item) => (item === null ? null : String(item))) : [];
}
